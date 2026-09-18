import { eq } from "drizzle-orm";
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

export async function getEvent(id: string) {
  const [row] = await db.select().from(events).where(eq(events.id, id));
  return row;
}

export async function addEventMetadata(id: string, metadataPatch: Record<string, unknown>) {
  const existing = await getEvent(id);
  const mergedMetadata = {
    ...(existing?.metadata as Record<string, unknown> | null),
    ...metadataPatch,
  };
  const [row] = await db
    .update(events)
    .set({ metadata: mergedMetadata })
    .where(eq(events.id, id))
    .returning();
  return row;
}

export async function markEventProcessed(id: string, metadataPatch?: Record<string, unknown>) {
  const existing = await getEvent(id);
  const mergedMetadata = {
    ...(existing?.metadata as Record<string, unknown> | null),
    ...metadataPatch,
  };
  const [row] = await db
    .update(events)
    .set({ processedAt: new Date(), metadata: mergedMetadata })
    .where(eq(events.id, id))
    .returning();
  return row;
}
