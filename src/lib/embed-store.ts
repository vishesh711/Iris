import { and, eq, gte } from "drizzle-orm";
import { db } from "../db/client.js";
import { embeddings } from "../db/schema.js";
import { chunkText, embedText } from "./embeddings.js";

export type EmbeddableSourceTable = "events" | "emails";

/**
 * Chunks and embeds text into the polymorphic embeddings table, keyed by
 * (sourceTable, sourceId, chunkIndex) — idempotent, so re-embedding the
 * same source (a re-ingested email, a backfill re-run) updates in place
 * rather than accumulating duplicates. Also deletes any leftover chunk
 * rows from a previous embedding of the same source that had more chunks
 * than this one, so shrinking content doesn't leave stale tail chunks.
 */
export async function embedAndStoreChunks(
  sourceTable: EmbeddableSourceTable,
  sourceId: string,
  text: string
): Promise<void> {
  const chunks = chunkText(text);
  if (chunks.length === 0) return;

  for (let i = 0; i < chunks.length; i++) {
    const vector = await embedText(chunks[i]);
    await db
      .insert(embeddings)
      .values({
        sourceTable,
        sourceId,
        chunkIndex: i,
        content: chunks[i],
        vector,
      })
      .onConflictDoUpdate({
        target: [embeddings.sourceTable, embeddings.sourceId, embeddings.chunkIndex],
        set: { content: chunks[i], vector },
      });
  }

  await db
    .delete(embeddings)
    .where(and(eq(embeddings.sourceTable, sourceTable), eq(embeddings.sourceId, sourceId), gte(embeddings.chunkIndex, chunks.length)));
}
