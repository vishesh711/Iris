import { transcribeAudio } from "../../lib/whisper.js";
import { recordEvent, markEventProcessed } from "../../lib/events.js";
import { getBoss, QUEUES } from "../../lib/queue.js";
import type { ClassifyJobData } from "./classify.js";

export interface TranscribeJobData {
  eventId: string;
  filePath: string;
  traceId?: string;
}

export async function runTranscribeJob(data: TranscribeJobData): Promise<void> {
  const text = await transcribeAudio(data.filePath);

  const transcriptEvent = await recordEvent({
    source: "telegram",
    type: "transcript",
    rawData: { text },
    metadata: { sourceEventId: data.eventId, traceId: data.traceId },
  });

  await markEventProcessed(data.eventId, { transcribed: true });

  const boss = await getBoss();
  await boss.send(QUEUES.classify, {
    eventId: transcriptEvent.id,
    traceId: data.traceId,
  } satisfies ClassifyJobData);
}
