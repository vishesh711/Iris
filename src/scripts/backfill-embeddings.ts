import "dotenv/config";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { embeddings, emails, events, memories } from "../db/schema.js";
import { embedAndStoreChunks, removeEmbedding } from "../lib/embed-store.js";
import { embedText } from "../lib/embeddings.js";
import { extractMessageText } from "../lib/extract-text.js";

/**
 * One-off backfill for data ingested before Milestone 4 existed —
 * without this, memories/events/emails from Milestones 1-3 would be
 * invisible to search even though the pipeline now embeds everything
 * going forward. Safe to re-run: embedAndStoreChunks and the
 * embedding-is-null memory update are both idempotent.
 *
 * Also purges any existing event embedding that no longer qualifies
 * under classify.ts's rules (fact/correction-labeled text, since that
 * content already lives in memories.embedding with supersession
 * tracking, or a question directed at Iris, which only pollutes future
 * searches by matching itself) — this repairs data embedded before
 * those rules existed.
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
  console.log(`Processing ${capturedEvents.length} captured events...`);
  let embedded = 0;
  let purged = 0;
  for (const event of capturedEvents) {
    const text = extractMessageText(event.rawData);
    const label = (event.metadata as { label?: string } | null)?.label;
    const isQuestion = text.trim().endsWith("?");
    if (text && label !== "fact" && label !== "correction" && !isQuestion) {
      await embedAndStoreChunks("events", event.id, text);
      embedded++;
    } else {
      const deleted = await db
        .delete(embeddings)
        .where(and(eq(embeddings.sourceTable, "events"), eq(embeddings.sourceId, event.id)))
        .returning();
      if (deleted.length > 0) purged++;
    }
  }
  console.log(`Embedded ${embedded} events, purged stale/excluded embeddings for ${purged} events.`);

  // Ground truth for "this content is already covered by memories.embedding
  // with supersession tracking, so it shouldn't also live on here" is
  // supersession itself, not the classifier's label - the label can be
  // inconsistent across near-duplicate messages (e.g. a repeated test
  // statement mislabeled as "conversation" on one attempt), which the
  // label-based pass above can't catch.
  const supersededMemories = await db.select().from(memories).where(eq(memories.status, "superseded"));
  let supersededEventsChecked = 0;
  for (const memory of supersededMemories) {
    for (const oldEventId of memory.sourceEventIds as string[]) {
      await removeEmbedding("events", oldEventId);
      supersededEventsChecked++;
    }
  }
  console.log(`Checked/purged embeddings for ${supersededEventsChecked} source events of ${supersededMemories.length} superseded memories.`);

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
