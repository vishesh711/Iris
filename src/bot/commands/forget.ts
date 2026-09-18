import { Markup, type Telegraf } from "telegraf";
import { approveAction, proposeAction, rejectAction } from "../../lib/actions.js";
import { recordEvent } from "../../lib/events.js";
import { previewForget } from "../../lib/memory.js";

/**
 * /forget hard-deletes by entity (per the PRD: superseded is the right
 * default for a correction, but the wrong one for a deliberate erase
 * request). It still goes through proposeAction like any other tier-2
 * tool — no bypass for arriving as a slash command — so it gets the same
 * approval card, audit trail, and idempotency guarantee.
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

    const { action, decision } = await proposeAction({
      tool: "memory.forget",
      args: { target, matchedIds: matches.map((memory) => memory.id) },
      rationale,
      sourceEventId: event.id,
    });

    if (decision === "queued") {
      const keyboard = Markup.inlineKeyboard([
        Markup.button.callback("Approve", `forget:approve:${action.id}`),
        Markup.button.callback("Reject", `forget:reject:${action.id}`),
      ]);
      await ctx.reply(`${rationale}\n\nApprove this deletion?`, {
        reply_markup: keyboard.reply_markup,
        message_thread_id: threadId,
      });
    } else {
      await ctx.reply(`Action ${decision}.`, { message_thread_id: threadId });
    }
  });

  bot.action(/^forget:(approve|reject):(.+)$/, async (ctx) => {
    const decisionKind = ctx.match[1];
    const actionId = ctx.match[2];

    const updated = decisionKind === "approve" ? await approveAction(actionId) : await rejectAction(actionId);

    const deletedCount =
      updated.status === "done" && updated.result && typeof updated.result === "object"
        ? (updated.result as { deletedCount?: number }).deletedCount
        : undefined;

    const summary =
      decisionKind === "approve"
        ? updated.status === "done"
          ? `Approved. Deleted ${deletedCount ?? 0} memories.`
          : `Approved, but execution ${updated.status}.`
        : "Rejected. Nothing was deleted.";

    await ctx.editMessageText(summary, { reply_markup: { inline_keyboard: [] } });
    await ctx.answerCbQuery();
  });
}
