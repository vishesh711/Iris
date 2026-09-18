import "dotenv/config";
import "../lib/network.js";
import { randomUUID } from "node:crypto";
import { Telegraf } from "telegraf";
import type { Message } from "telegraf/types";
import { addEventMetadata, recordEvent } from "../lib/events.js";
import { downloadTelegramFile } from "../lib/storage.js";
import { getBoss, QUEUES } from "../lib/queue.js";
import type { TranscribeJobData } from "../worker/jobs/transcribe.js";
import type { ClassifyJobData } from "../worker/jobs/classify.js";
import type { AskJobData } from "../worker/jobs/ask.js";
import { registerForgetCommand } from "./commands/forget.js";
import { registerApprovalHandlers } from "./commands/approvals.js";
import { registerAutonomyCommand } from "./commands/autonomy.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is not set");
}

const bot = new Telegraf(token);

// Registered before the generic message handler: Telegraf stops at the
// first matching handler, so /forget messages are fully handled here
// (including their own recordEvent call) and never also get treated as
// an ordinary capture-and-classify message below.
registerForgetCommand(bot);
registerApprovalHandlers(bot);
registerAutonomyCommand(bot);

bot.on("message", async (ctx) => {
  const message = ctx.message as Message;
  const traceId = randomUUID();

  const event = await recordEvent({
    source: "telegram",
    type: "message",
    rawData: message,
    metadata: { traceId },
  });

  await ctx.reply("got it.", {
    message_thread_id: "message_thread_id" in message ? message.message_thread_id : undefined,
  });

  const boss = await getBoss();

  if ("voice" in message && message.voice) {
    const { path } = await downloadTelegramFile(ctx.telegram, message.voice.file_id, ".oga");
    await addEventMetadata(event.id, { filePath: path });
    await boss.send(QUEUES.transcribe, {
      eventId: event.id,
      filePath: path,
      traceId,
    } satisfies TranscribeJobData);
    return;
  }

  if ("audio" in message && message.audio) {
    const { path } = await downloadTelegramFile(ctx.telegram, message.audio.file_id, ".mp3");
    await addEventMetadata(event.id, { filePath: path });
    await boss.send(QUEUES.transcribe, {
      eventId: event.id,
      filePath: path,
      traceId,
    } satisfies TranscribeJobData);
    return;
  }

  if ("document" in message && message.document) {
    const ext = message.document.file_name ? `-${message.document.file_name}` : "";
    const { path } = await downloadTelegramFile(ctx.telegram, message.document.file_id, ext);
    await addEventMetadata(event.id, { filePath: path });
  }

  if ("photo" in message && message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    const { path } = await downloadTelegramFile(ctx.telegram, largest.file_id, ".jpg");
    await addEventMetadata(event.id, { filePath: path });
  }

  await boss.send(QUEUES.classify, { eventId: event.id, traceId } satisfies ClassifyJobData);

  // A trivial, zero-cost check (no model call, so it doesn't slow the
  // "got it." ack) — a real free-form question triggers the Ask flow
  // alongside ordinary capture, not instead of it.
  if ("text" in message && message.text.trim().endsWith("?")) {
    await boss.send(QUEUES.ask, { eventId: event.id } satisfies AskJobData);
  }
});

bot.launch();
console.log("Iris bot is listening.");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
