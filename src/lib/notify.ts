import { Telegram } from "telegraf";

let telegram: Telegram | null = null;

function getTelegram(): Telegram | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  if (!telegram) {
    telegram = new Telegram(token);
  }
  return telegram;
}

/**
 * Sends a message directly via the Bot API, without needing a running
 * long-poll bot instance — used for alerts the worker needs to raise on
 * its own (an expired Google token, for example), which must surface
 * immediately rather than wait for the user to next message the bot.
 */
export async function notifyOwner(text: string): Promise<void> {
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID;
  if (!chatId) {
    console.error("TELEGRAM_OWNER_CHAT_ID is not set; dropping notification:", text);
    return;
  }

  const client = getTelegram();
  if (!client) {
    console.error("TELEGRAM_BOT_TOKEN is not set; dropping notification:", text);
    return;
  }

  await client.sendMessage(chatId, text);
}
