import { db } from "../db/client.js";
import { events } from "../db/schema.js";

export async function recordEvent(params: {
  source: string;
  type: string;
  rawData: unknown;
  metadata?: unknown;
}) {
  const [row] = await db
    .insert(events)
    .values({
      source: params.source,
      type: params.type,
      rawData: params.rawData,
      metadata: params.metadata,
    })
    .returning();
  return row;
}
