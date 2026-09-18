import type { Telegraf } from "telegraf";
import { proposeAction } from "../../lib/actions.js";
import { recordEvent } from "../../lib/events.js";
import { previewForget } from "../../lib/memory.js";

/**
 * /forget hard-deletes by entity (per the PRD: superseded is the right
 * default for a correction, but the wrong one for a deliberate erase
 * request). It still goes through proposeAction like any other tier-2
 * tool — no bypass for arriving as a slash command — so it gets the same
 * approval card (sent by proposeAction itself; see telegram-cards.ts and
 * approvals.ts's generic approve/reject handler), audit trail, and
 * idempotency guarantee.
 */
export function registerForgetCommand(bot: Telegraf): void {
  bot.command("forget", async (ctx) => {
    const target = ctx.message.text.replace(/^\/forget(@\w+)?\s*/, "").trim();
    const threadId = "message_thread_id" in ctx.message ? ctx.message.message_thread_id : undefined;

    const event = await recordEvent({
      source: "telegram",
      type: "command",
      rawData: ctx.message,
      metadata: { command: "forget", target },
    });

    if (!target) {
      await ctx.reply("Usage: /forget <what to forget>", { message_thread_id: threadId });
      return;
    }

    const matches = await previewForget(target);
    if (matches.length === 0) {
      await ctx.reply(`Nothing found matching "${target}".`, { message_thread_id: threadId });
      return;
    }

    const rationale = `Delete ${matches.length} memor${matches.length === 1 ? "y" : "ies"} matching "${target}":\n${matches
      .map((memory) => `- ${memory.statement}`)
      .join("\n")}`;

    const { decision } = await proposeAction({
      tool: "memory.forget",
      args: { target, matchedIds: matches.map((memory) => memory.id) },
      rationale,
      sourceEventId: event.id,
    });

    await ctx.reply(decision === "queued" ? "Sent for approval — check the approvals topic." : `Action ${decision}.`, {
      message_thread_id: threadId,
    });
  });
}
