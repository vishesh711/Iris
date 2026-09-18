import "dotenv/config";
import { Telegraf } from "telegraf";
import { recordEvent } from "../lib/events.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is not set");
}

const bot = new Telegraf(token);

bot.on("message", async (ctx) => {
  await recordEvent({
    source: "telegram",
    type: "message",
    rawData: ctx.message,
  });
  await ctx.reply("got it.");
});

bot.launch();
console.log("Iris bot is listening.");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
