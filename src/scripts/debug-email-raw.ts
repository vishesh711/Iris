import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { emails } from "../db/schema.js";

/**
 * Ad-hoc debug tool: dumps the MIME part tree of a stored email's raw
 * Gmail API payload (mimeType + headers) for a given emails.id, to check
 * for a Content-Transfer-Encoding our body-text extraction might be
 * ignoring (e.g. quoted-printable, which needs decoding beyond the
 * outer base64url transport encoding).
 */
const emailId = process.argv[2];
if (!emailId) {
  console.error("Usage: tsx src/scripts/debug-email-raw.ts <emails.id>");
  process.exit(1);
}

interface RawPart {
  mimeType?: string;
  headers?: { name?: string; value?: string }[];
  body?: { data?: string; size?: number };
  parts?: RawPart[];
}

function walk(part: RawPart | undefined, depth: number): void {
  if (!part) return;
  const cte = part.headers?.find((h) => h.name?.toLowerCase() === "content-transfer-encoding")?.value;
  const dataPreview = part.body?.data?.slice(0, 60);
  console.log(`${"  ".repeat(depth)}mimeType=${part.mimeType} cte=${cte ?? "(none)"} size=${part.body?.size} dataPreview=${dataPreview}`);
  for (const child of part.parts ?? []) {
    walk(child, depth + 1);
  }
}

async function main() {
  const [row] = await db.select().from(emails).where(eq(emails.id, emailId));
  if (!row) {
    console.error("No email with that id");
    process.exit(1);
  }
  const raw = row.raw as { payload?: RawPart };
  console.log(`Subject: ${row.subject}`);
  console.log(`From: ${row.fromAddress}\n`);
  walk(raw.payload, 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
