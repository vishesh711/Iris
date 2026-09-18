import { answerQuestion } from "../../lib/ask.js";
import { getEvent } from "../../lib/events.js";
import { sendMessage } from "../../lib/notify.js";

export interface AskJobData {
  eventId: string;
}

interface TelegramMessageShape {
  text?: string;
  chat?: { id?: number | string };
  message_thread_id?: number;
}

export async function runAskJob(data: AskJobData): Promise<void> {
  const event = await getEvent(data.eventId);
  if (!event) return;

  const message = event.rawData as TelegramMessageShape;
  const question = message.text;
  const chatId = message.chat?.id;
  if (!question || chatId === undefined) return;

  const answer = await answerQuestion(question);
  await sendMessage(chatId, answer, message.message_thread_id);
}
