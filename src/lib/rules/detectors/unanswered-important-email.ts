import { sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import type { RuleCandidate } from "../types.js";

const STALE_AFTER_DAYS = 2;

interface Row {
  [key: string]: unknown;
  email_id: string;
  entity_id: string | null;
  from_name: string | null;
  from_address: string;
  subject: string | null;
  received_at: Date;
}

/**
 * Deterministic SQL only (invariant 8): a real person's email (has a
 * display name, not an automated/no-reply address, not already covered
 * by the recruiter-follow-up rule) with nothing newer in the thread,
 * older than the cooldown window.
 */
export async function detectUnansweredImportantEmail(): Promise<RuleCandidate[]> {
  const result = await db.execute<Row>(sql`
    select e.id as email_id, e.entity_id, e.from_name, e.from_address, e.subject, e.received_at
    from emails e
    left join entities en on en.id = e.entity_id
    where (en.type is null or en.type != 'recruiter')
      and e.from_name is not null
      and e.from_address not ilike '%noreply%'
      and e.from_address not ilike '%no-reply%'
      and e.from_address not ilike '%notifications%'
      and e.from_address not ilike '%donotreply%'
      and e.subject not ilike '%verification code%'
      and e.subject not ilike '%passcode%'
      and e.subject not ilike '%one-time%'
      and e.subject not ilike '%confirm your identity%'
      and e.received_at < now() - (${STALE_AFTER_DAYS} * interval '1 day')
      and not exists (
        select 1 from emails e2
        where e2.thread_id = e.thread_id
          and e2.received_at > e.received_at
      )
    order by e.received_at desc
    limit 20
  `);

  return result.rows.map((row) => ({
    entityId: row.entity_id,
    dedupeKey: row.entity_id ?? row.email_id,
    summary: `No reply since ${row.from_name ?? row.from_address} emailed about "${row.subject ?? "(no subject)"}" on ${new Date(row.received_at).toDateString()}.`,
    metadata: { emailId: row.email_id, fromAddress: row.from_address, subject: row.subject, receivedAt: row.received_at },
  }));
}
