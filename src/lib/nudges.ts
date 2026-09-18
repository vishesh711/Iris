import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { nudges } from "../db/schema.js";
import type { RuleCandidate } from "./rules/types.js";

export type NudgeRow = typeof nudges.$inferSelect;

/**
 * Cooldown/backoff, addressed structurally rather than as a timer: a
 * nudge for the same (rule, subject) simply can't be created again while
 * an earlier one for it is still undismissed - there's nothing to
 * re-fire, so "fires every morning for six days" and same-day
 * re-notification are both impossible by construction. Dismissing the
 * old nudge is what reopens the door for a new one.
 */
export async function proposeNudge(params: {
  ruleId: string;
  candidate: RuleCandidate;
  title: string;
  body: string;
}): Promise<{ created: boolean; nudge?: NudgeRow }> {
  const { ruleId, candidate } = params;

  const existing = candidate.entityId
    ? await db
        .select({ id: nudges.id })
        .from(nudges)
        .where(and(eq(nudges.ruleId, ruleId), eq(nudges.entityId, candidate.entityId), eq(nudges.dismissed, false)))
    : await db
        .select({ id: nudges.id })
        .from(nudges)
        .where(
          and(
            eq(nudges.ruleId, ruleId),
            eq(nudges.dismissed, false),
            sql`${nudges.metadata} ->> 'dedupeKey' = ${candidate.dedupeKey}`
          )
        );

  if (existing.length > 0) {
    return { created: false };
  }

  try {
    const [nudge] = await db
      .insert(nudges)
      .values({
        ruleId,
        entityId: candidate.entityId,
        title: params.title,
        body: params.body,
        metadata: { ...candidate.metadata, dedupeKey: candidate.dedupeKey },
        sentAt: new Date(),
      })
      .returning();
    return { created: true, nudge };
  } catch (err) {
    // Unique-constraint race against a concurrent run for the same
    // (rule, entity) - another run already created this nudge.
    if ((err as { code?: string }).code === "23505") {
      return { created: false };
    }
    throw err;
  }
}

export async function dismissNudge(id: string): Promise<void> {
  await db.update(nudges).set({ dismissed: true, dismissedAt: new Date() }).where(eq(nudges.id, id));
}

export async function listActiveNudges(): Promise<NudgeRow[]> {
  return db.select().from(nudges).where(eq(nudges.dismissed, false));
}
