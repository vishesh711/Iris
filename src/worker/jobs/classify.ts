import { classifyCapture } from "../../lib/classifier.js";
import { getEvent, markEventProcessed } from "../../lib/events.js";

export interface ClassifyJobData {
  eventId: string;
  traceId?: string;
}

function extractText(rawData: unknown): string {
  if (rawData && typeof rawData === "object") {
    const data = rawData as Record<string, unknown>;
    if (typeof data.text === "string") return data.text;
    if (typeof data.caption === "string") return data.caption;
  }
  return "";
}

export async function runClassifyJob(data: ClassifyJobData): Promise<void> {
  const event = await getEvent(data.eventId);
  if (!event) return;

  const text = extractText(event.rawData);
  if (!text) {
    await markEventProcessed(event.id, { label: "conversation", labelSkipped: true });
    return;
  }

  const label = await classifyCapture(text);
  await markEventProcessed(event.id, { label });
}
