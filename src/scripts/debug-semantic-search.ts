import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { embeddings } from "../db/schema.js";
import { embedText } from "../lib/embeddings.js";

/**
 * Ad-hoc debug tool: replicates retrieval.ts's semanticSearch query
 * exactly, but also selects embeddings.id and chunk_index, so a
 * suspicious result's row identity can be directly compared against a
 * known-clean row looked up by source_id (debug-embeddings-raw.ts).
 */
function vectorParam(vector: number[]) {
  return sql`${`[${vector.join(",")}]`}::vector`;
}

const query = process.argv[2] ?? "Who was the recruiter that contacted me about the contract role, and what did I decide about the rate?";

async function main() {
  const queryVector = await embedText(query);
  const distance = sql<number>`${embeddings.vector} <=> ${vectorParam(queryVector)}`;

  const rows = await db
    .select({
      id: embeddings.id,
      sourceTable: embeddings.sourceTable,
      sourceId: embeddings.sourceId,
      chunkIndex: embeddings.chunkIndex,
      content: embeddings.content,
      distance,
    })
    .from(embeddings)
    .orderBy(distance)
    .limit(8);

  for (const row of rows) {
    console.log(`id=${row.id} sourceId=${row.sourceId} chunk=${row.chunkIndex} distance=${row.distance}`);
    console.log(row.content);
    console.log("---");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
