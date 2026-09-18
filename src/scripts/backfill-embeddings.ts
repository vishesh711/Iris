import "dotenv/config";
import { eq, isNull, notInArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { emails, events, memories } from "../db/schema.js";
import { embedAndStoreChunks } from "../lib/embed-store.js";
import { embedText } from "../lib/embeddings.js";
import { extractMessageText } from "../lib/extract-text.js";

/**
 * One-off backfill for data ingested before Milestone 4 existed —
 * without this, memories/events/emails from Milestones 1-3 would be
 * invisible to search even though the pipeline now embeds everything
 * going forward. Safe to re-run: embedAndStoreChunks and the
 * embedding-is-null memory update are both idempotent.
 */
async function main() {
  const memoriesWithoutEmbedding = await db.select().from(memories).where(isNull(memories.embedding));
  console.log(`Backfilling ${memoriesWithoutEmbedding.length} memories...`);
  for (const memory of memoriesWithoutEmbedding) {
    const vector = await embedText(memory.statement);
    await db.update(memories).set({ embedding: vector }).where(eq(memories.id, memory.id));
  }

  const capturedEvents = await db
    .select()
    .from(events)
    .where(notInArray(events.type, ["command", "correction"]));
  console.log(`Backfilling up to ${capturedEvents.length} captured events...`);
  for (const event of capturedEvents) {
    const text = extractMessageText(event.rawData);
    if (!text) continue;
    await embedAndStoreChunks("events", event.id, text);
  }

  const allEmails = await db.select().from(emails);
  console.log(`Backfilling ${allEmails.length} emails...`);
  for (const email of allEmails) {
    const text = `${email.subject ?? ""}\n${email.bodyText ?? email.snippet ?? ""}`;
    await embedAndStoreChunks("emails", email.id, text);
  }

  console.log("Backfill complete.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
