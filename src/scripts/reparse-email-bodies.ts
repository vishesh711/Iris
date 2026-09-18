import "dotenv/config";
import { eq } from "drizzle-orm";
import type { gmail_v1 } from "googleapis";
import { db } from "../db/client.js";
import { emails } from "../db/schema.js";
import { parseMessage } from "../lib/google/gmail.js";

/**
 * One-off repair: emails ingested before the quoted-printable decode fix
 * have corrupted body_text already stored (extractPlainText only undid
 * the base64url transport wrapper, never the part's own
 * Content-Transfer-Encoding). The original raw Gmail payload is still
 * stored per email, so this re-runs parseMessage against it and updates
 * body_text in place - no re-fetch from Gmail needed. Run
 * `npm run backfill:embeddings` afterwards to re-embed the corrected
 * text.
 */
async function main() {
  const rows = await db.select().from(emails);
  let changed = 0;
  for (const row of rows) {
    const reparsed = parseMessage(row.raw as gmail_v1.Schema$Message);
    if (reparsed.bodyText !== row.bodyText) {
      await db.update(emails).set({ bodyText: reparsed.bodyText }).where(eq(emails.id, row.id));
      changed++;
    }
  }
  console.log(`Re-parsed ${rows.length} emails, updated ${changed}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
