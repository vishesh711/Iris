import { sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import type { RuleCandidate } from "../types.js";

const LOOKAHEAD_DAYS = 3;

interface Row {
  [key: string]: unknown;
  id: string;
  title: string | null;
  location: string | null;
  start_at: Date;
}

/**
 * Deterministic SQL only (invariant 8): a calendar event whose title or
 * description mentions an interview, starting within the lookahead
 * window. No entity to key off of, so dedupeKey is the event's own id.
 */
export async function detectUpcomingInterview(): Promise<RuleCandidate[]> {
  const result = await db.execute<Row>(sql`
    select id, title, location, start_at
    from calendar_events
    where start_at between now() and now() + (${LOOKAHEAD_DAYS} * interval '1 day')
      and (title ilike '%interview%' or description ilike '%interview%')
    order by start_at asc
    limit 20
  `);

  return result.rows.map((row) => ({
    entityId: null,
    dedupeKey: row.id,
    summary: `Interview "${row.title ?? "(untitled)"}" starts ${new Date(row.start_at).toLocaleString()}${row.location ? ` at ${row.location}` : ""}.`,
    metadata: { calendarEventId: row.id, title: row.title, startAt: row.start_at },
  }));
}
