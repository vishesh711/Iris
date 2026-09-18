import { classifyCapture } from "../../lib/classifier.js";
import { getEvent, markEventProcessed } from "../../lib/events.js";
import { extractMessageText } from "../../lib/extract-text.js";
import { getBoss, QUEUES } from "../../lib/queue.js";
import type { ExtractMemoryJobData } from "./extract-memory.js";
import type { EmbedJobData } from "./embed.js";

export interface ClassifyJobData {
  eventId: string;
  traceId?: string;
}

export async function runClassifyJob(data: ClassifyJobData): Promise<void> {
  const event = await getEvent(data.eventId);
  if (!event) return;

  const text = extractMessageText(event.rawData);
  if (!text) {
    await markEventProcessed(event.id, { label: "conversation", labelSkipped: true });
    return;
  }

  const label = await classifyCapture(text);
  await markEventProcessed(event.id, { label });

  const boss = await getBoss();

  if (label === "fact" || label === "correction") {
    await boss.send(QUEUES.extractMemory, {
      eventId: event.id,
      label,
      traceId: data.traceId,
    } satisfies ExtractMemoryJobData);
  }

  // Facts/corrections are already captured - with supersession tracking
  // - via memories.embedding. Embedding the raw event text too would
  // create a permanent, supersession-blind duplicate: correct a fact
  // later and the old statement still resurfaces here forever, since
  // this table has no notion of "superseded". A question directed at
  // Iris has no future recall value and only pollutes later searches by
  // matching itself almost perfectly. Only free-standing conversational
  // content (tasks, reminders, small talk) is worth indexing here.
  const isQuestion = text.trim().endsWith("?");
  if (label !== "fact" && label !== "correction" && !isQuestion) {
    await boss.send(QUEUES.embed, {
      sourceTable: "events",
      sourceId: event.id,
      text,
    } satisfies EmbedJobData);
  }
}
