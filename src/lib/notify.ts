import { Telegram } from "telegraf";
import type { InlineKeyboardMarkup } from "telegraf/types";

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
 * long-poll bot instance — used for worker/executor-raised alerts, the
 * Ask flow's answers, and approval cards, none of which have a live
 * Telegraf context to reply through.
 */
export async function sendMessage(
  chatId: string | number,
  text: string,
  threadId?: number,
  replyMarkup?: InlineKeyboardMarkup
): Promise<void> {
  const client = getTelegram();
  if (!client) {
    console.error("TELEGRAM_BOT_TOKEN is not set; dropping message:", text);
    return;
  }
  await client.sendMessage(chatId, text, {
    ...(threadId ? { message_thread_id: threadId } : {}),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

export async function notifyOwner(text: string, threadId?: number): Promise<void> {
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID;
  if (!chatId) {
    console.error("TELEGRAM_OWNER_CHAT_ID is not set; dropping notification:", text);
    return;
  }
  await sendMessage(chatId, text, threadId);
}
