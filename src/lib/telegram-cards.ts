import type { InlineKeyboardMarkup } from "telegraf/types";
import { topicThreadId } from "../bot/topics.js";
import type { ActionRow } from "./actions.js";
import { extractMessageText } from "./extract-text.js";
import { getEvent } from "./events.js";
import { sendMessage } from "./notify.js";

function buildKeyboard(actionId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "Approve", callback_data: `action:approve:${actionId}` },
        { text: "Reject", callback_data: `action:reject:${actionId}` },
      ],
    ],
  };
}

async function getSourceSnippet(sourceEventId: string): Promise<string | null> {
  const event = await getEvent(sourceEventId);
  if (!event) return null;
  const text = extractMessageText(event.rawData);
  return text ? text.slice(0, 300) : null;
}

/**
 * Real approval cards (tool, args, rationale, tier, source snippet),
 * replacing Milestone 2's throwaway inline confirm. Sent via the direct
 * Bot API (notify.ts), not a live ctx.reply, so any process - bot,
 * worker, or the executor - can propose an action and get a real card
 * out, not just the one flow that happened to have a live chat context.
 */
export async function sendApprovalCard(action: ActionRow): Promise<void> {
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID;
  if (!chatId) {
    console.error("TELEGRAM_OWNER_CHAT_ID is not set; dropping approval card for action:", action.id);
    return;
  }

  const snippet = action.sourceEventId ? await getSourceSnippet(action.sourceEventId) : null;

  const lines = [`Approve this action?`, ``, `Tool: ${action.tool}`, `Tier: ${action.tier}`, `Args: ${JSON.stringify(action.args)}`];
  if (action.rationale) lines.push(`Rationale: ${action.rationale}`);
  if (action.untrusted) lines.push(`⚠️ Untrusted source content was involved in this proposal.`);
  if (snippet) lines.push(``, `Source: "${snippet}"`);

  await sendMessage(chatId, lines.join("\n"), topicThreadId("approvals"), buildKeyboard(action.id));
}
