import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { embeddings } from "../db/schema.js";

/**
 * Ad-hoc debug tool: queries the embeddings table through the app's own
 * Drizzle/pg connection (same DATABASE_URL, same code path as
 * retrieval.ts) rather than psql, to check for a split-brain database
 * situation where `docker exec psql` and the Node app are actually
 * talking to two different Postgres instances (e.g. a stale local
 * Postgres process squatting on the same host port).
 */
const sourceId = process.argv[2];
if (!sourceId) {
  console.error("Usage: tsx src/scripts/debug-embeddings-raw.ts <sourceId>");
  process.exit(1);
}

async function main() {
  console.log(`DATABASE_URL=${process.env.DATABASE_URL}`);
  const rows = await db.select().from(embeddings).where(eq(embeddings.sourceId, sourceId));
  console.log(`${rows.length} rows for sourceId=${sourceId}\n`);
  for (const row of rows) {
    console.log(`--- chunk ${row.chunkIndex} (embeddings.id=${row.id}, created_at=${row.createdAt.toISOString()}) ---`);
    console.log(row.content);
    console.log();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
