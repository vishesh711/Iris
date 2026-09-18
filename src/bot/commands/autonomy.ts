import type { Telegraf } from "telegraf";
import { clearAutonomyOverride, setAutonomyOverride, AUTO_APPROVE_LEVEL } from "../../lib/autonomy.js";

/**
 * The only way a tool ever gets auto-approved beyond its static tier —
 * checkAutonomyPromotion only ever offers, this command is what the
 * person uses to actually accept (or decline) that offer.
 */
export function registerAutonomyCommand(bot: Telegraf): void {
  bot.command("autonomy", async (ctx) => {
    const args = ctx.message.text.replace(/^\/autonomy(@\w+)?\s*/, "").trim().split(/\s+/);
    const threadId = "message_thread_id" in ctx.message ? ctx.message.message_thread_id : undefined;

    if (args.length !== 2 || !["on", "off"].includes(args[1])) {
      await ctx.reply("Usage: /autonomy <tool> <on|off>", { message_thread_id: threadId });
      return;
    }

    const [tool, mode] = args;

    if (mode === "on") {
      await setAutonomyOverride(tool, AUTO_APPROVE_LEVEL);
      await ctx.reply(`"${tool}" will be auto-approved from now on. Say /autonomy ${tool} off any time to require approval again.`, {
        message_thread_id: threadId,
      });
    } else {
      await clearAutonomyOverride(tool);
      await ctx.reply(`"${tool}" now requires approval again.`, { message_thread_id: threadId });
    }
  });
}
