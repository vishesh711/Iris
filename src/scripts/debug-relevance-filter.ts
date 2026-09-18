import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { filterRelevantCandidates } from "../lib/rules/relevance-filter.js";
import type { RuleCandidate } from "../lib/rules/types.js";

/**
 * Dry-run: pulls real recruiter-thread candidates ignoring the 3-day
 * cooldown (so there's actually something to filter today) and runs the
 * real relevance-filter model call against them, without writing to
 * nudges or sending any Telegram message. Verifies the filter has enough
 * judgment to decline nudging on closed/rejected threads, not just that
 * the detector's SQL finds rows.
 */
interface Row {
  [key: string]: unknown;
  email_id: string;
  entity_id: string;
  from_name: string | null;
  from_address: string;
  subject: string | null;
  snippet: string | null;
  received_at: Date;
}

async function main() {
  const result = await db.execute<Row>(sql`
    select e.id as email_id, e.entity_id, e.from_name, e.from_address, e.subject, e.snippet, e.received_at
    from emails e
    join entities en on en.id = e.entity_id
    where en.type = 'recruiter'
      and e.received_at < now() - interval '1 minute'
      and not exists (
        select 1 from emails e2
        where e2.thread_id = e.thread_id
          and e2.received_at > e.received_at
      )
    order by e.received_at desc
    limit 20
  `);

  const candidates: RuleCandidate[] = result.rows.map((row) => ({
    entityId: row.entity_id,
    dedupeKey: row.entity_id,
    summary: `Email from ${row.from_name ?? row.from_address}, subject "${row.subject ?? "(no subject)"}", snippet: "${row.snippet ?? ""}", received ${new Date(row.received_at).toDateString()}. No reply since.`,
    metadata: { emailId: row.email_id },
  }));

  console.log(`${candidates.length} candidates:\n`);
  candidates.forEach((c, i) => console.log(`${i + 1}. ${c.summary}`));

  console.log("\nRunning relevance filter (dry run, no DB writes, no Telegram)...\n");
  const selected = await filterRelevantCandidates("recruiter-follow-up", candidates);

  console.log(`${selected.length} selected:\n`);
  for (const s of selected) {
    console.log(`- ${s.title}: ${s.body}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
