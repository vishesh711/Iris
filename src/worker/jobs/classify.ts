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

  await boss.send(QUEUES.embed, {
    sourceTable: "events",
    sourceId: event.id,
    text,
  } satisfies EmbedJobData);
}
