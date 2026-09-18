import "dotenv/config";
import { and, desc, eq, ilike, isNotNull, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { calendarEvents, embeddings, emails, events, memories } from "../db/schema.js";
import { embedText } from "../lib/embeddings.js";
import { extractKeywords } from "../lib/retrieval.js";

/**
 * Ad-hoc debug tool: replicates retrieve()'s exact full sequence (memory,
 * semantic, structured email, structured calendar, recent events), and
 * re-prints the SAME semantic-search row objects both immediately after
 * fetching them and again after the later legs run - to check whether a
 * later, unrelated query is somehow mutating an already-returned row's
 * content value (as opposed to the semantic query itself ever having
 * fetched the wrong value).
 */
function vectorParam(vector: number[]) {
  return sql`${`[${vector.join(",")}]`}::vector`;
}

const query = process.argv[2] ?? "Who was the recruiter that contacted me about the contract role, and what did I decide about the rate?";

async function runMemoryQuery(queryVector: number[]) {
  const distance = sql<number>`${memories.embedding} <=> ${vectorParam(queryVector)}`;
  return db
    .select({ id: memories.id, statement: memories.statement, distance })
    .from(memories)
    .where(and(eq(memories.status, "active"), isNotNull(memories.embedding)))
    .orderBy(distance)
    .limit(8);
}

async function runSemanticQuery(queryVector: number[]) {
  const distance = sql<number>`${embeddings.vector} <=> ${vectorParam(queryVector)}`;
  return db
    .select({ id: embeddings.id, sourceId: embeddings.sourceId, chunkIndex: embeddings.chunkIndex, content: embeddings.content, distance })
    .from(embeddings)
    .orderBy(distance)
    .limit(8);
}

async function runStructuredEmailQuery(q: string) {
  const keywords = extractKeywords(q);
  const conditions = keywords.flatMap((word) => {
    const pattern = `%${word}%`;
    return [ilike(emails.subject, pattern), ilike(emails.bodyText, pattern), ilike(emails.fromAddress, pattern)];
  });
  return db.select().from(emails).where(or(...conditions)).orderBy(desc(emails.receivedAt)).limit(30);
}

async function runStructuredCalendarQuery(q: string) {
  const keywords = extractKeywords(q);
  const conditions = keywords.flatMap((word) => {
    const pattern = `%${word}%`;
    return [ilike(calendarEvents.title, pattern), ilike(calendarEvents.description, pattern)];
  });
  if (conditions.length === 0) return [];
  return db.select().from(calendarEvents).where(or(...conditions)).orderBy(desc(calendarEvents.startAt)).limit(30);
}

async function runRecentEventsQuery() {
  return db.select().from(events).orderBy(desc(events.receivedAt)).limit(5);
}

function printSemRows(label: string, rows: Awaited<ReturnType<typeof runSemanticQuery>>) {
  console.log(`=== ${label} ===`);
  for (const row of rows) {
    console.log(`id=${row.id} sourceId=${row.sourceId} chunk=${row.chunkIndex}`);
    console.log(row.content);
    console.log("---");
  }
}

async function main() {
  const queryVector = await embedText(query);

  await runMemoryQuery(queryVector);
  const semRows = await runSemanticQuery(queryVector);
  printSemRows("Semantic rows IMMEDIATELY after fetch", semRows);

  await runStructuredEmailQuery(query);
  await runStructuredCalendarQuery(query);
  await runRecentEventsQuery();

  printSemRows("SAME row objects AFTER the other legs ran", semRows);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
