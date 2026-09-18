import type { Telegraf } from "telegraf";
import { approveAction, rejectAction } from "../../lib/actions.js";

/**
 * One generic approve/reject handler for every tier-2 (or untrusted)
 * tool's approval card, replacing Milestone 2's /forget-specific
 * version — approveAction/rejectAction were already tool-agnostic, this
 * just stops assuming every card came from /forget. Execution itself
 * now happens in the separate executor process, so approving here only
 * ever reports "sent for execution," never a result — the executor
 * sends its own follow-up once it's actually done.
 */
export function registerApprovalHandlers(bot: Telegraf): void {
  bot.action(/^action:(approve|reject):(.+)$/, async (ctx) => {
    const decisionKind = ctx.match[1] as "approve" | "reject";
    const actionId = ctx.match[2];

    await (decisionKind === "approve" ? approveAction(actionId) : rejectAction(actionId));

    const summary = decisionKind === "approve" ? "Approved — executing shortly." : "Rejected. Nothing was executed.";

    await ctx.editMessageText(summary, { reply_markup: { inline_keyboard: [] } });
    await ctx.answerCbQuery();
  });
}
