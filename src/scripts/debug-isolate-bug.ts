import "dotenv/config";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { embeddings, memories } from "../db/schema.js";
import { embedText } from "../lib/embeddings.js";

/**
 * Ad-hoc debug tool: isolates whether running a DIFFERENT pgvector query
 * (memorySearch-shaped) immediately before the semantic-search query, in
 * the same process/connection pool, is what causes the semantic query to
 * return the right row (by id) with the wrong content - reproduced via
 * retrieve() but not via a standalone single-query script.
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

async function main() {
  const queryVector = await embedText(query);

  console.log("=== Running memory query FIRST, then semantic query (same process) ===");
  const memRows = await runMemoryQuery(queryVector);
  console.log(`memory rows: ${memRows.length}`);
  const semRows = await runSemanticQuery(queryVector);
  for (const row of semRows) {
    console.log(`id=${row.id} sourceId=${row.sourceId} chunk=${row.chunkIndex}`);
    console.log(row.content);
    console.log("---");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
