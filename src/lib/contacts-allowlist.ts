import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

/**
 * A recipient is allowed only if they've previously emailed the person —
 * built from real prior correspondence, never a list the model can grow
 * on its own. Checked at execution time (invariant-driven: injection
 * from untrusted email content can't argue its way past code that never
 * consults it), not just as an advisory check before proposing.
 */
export async function isAllowedRecipient(address: string): Promise<boolean> {
  const normalized = address.trim().toLowerCase();
  if (!normalized) return false;

  const result = await db.execute<{ allowed: boolean }>(sql`
    select exists(select 1 from emails where lower(from_address) = ${normalized}) as allowed
  `);

  return result.rows[0]?.allowed ?? false;
}
