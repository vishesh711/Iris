import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { memories } from "../db/schema.js";
import { decayWeight, type DecayClass } from "./decay.js";
import { removeEmbedding } from "./embed-store.js";
import { addEventMetadata } from "./events.js";
import { embedText } from "./embeddings.js";
import type { MemoryCandidate } from "./memory-extraction.js";
import { ollamaGenerate } from "./ollama.js";

export type Certainty = "asserted" | "inferred" | "contradicted";
export type MemoryRow = typeof memories.$inferSelect;

export async function findActiveMemoriesBySubject(subject: string): Promise<MemoryRow[]> {
  return db
    .select()
    .from(memories)
    .where(and(eq(memories.subject, subject), eq(memories.status, "active")));
}

export async function rememberFact(
  candidate: MemoryCandidate,
  params: { certainty: Certainty; sourceEventId: string; supersedes?: string }
): Promise<MemoryRow> {
  const vector = await embedText(candidate.statement);
  const [row] = await db
    .insert(memories)
    .values({
      statement: candidate.statement,
      subject: candidate.subject,
      predicate: candidate.predicate,
      object: candidate.object,
      certainty: params.certainty,
      decayClass: candidate.decayClass,
      sourceEventIds: [params.sourceEventId],
      supersedes: params.supersedes,
      embedding: vector,
    })
    .returning();
  return row;
}

export async function supersedeMemory(id: string): Promise<void> {
  await db.update(memories).set({ status: "superseded" }).where(eq(memories.id, id));
}

export async function bumpReinforcement(id: string): Promise<void> {
  await db
    .update(memories)
    .set({
      reinforcementCount: sql`${memories.reinforcementCount} + 1`,
      lastConfirmedAt: new Date(),
    })
    .where(eq(memories.id, id));
}

export interface ConflictResult {
  relationship: "contradicts" | "extends" | "independent";
  contradictedIndex: number | null;
}

const CONFLICT_SYSTEM_PROMPT = `Given a NEW statement and a numbered list of EXISTING statements about the same subject, classify the relationship of NEW to the EXISTING statements as exactly one of: contradicts, extends, independent.
- contradicts: NEW makes one of the EXISTING statements false or outdated (e.g. a changed city, job, or decision)
- extends: NEW adds detail without invalidating any EXISTING statement
- independent: NEW is unrelated to the EXISTING statements despite sharing a subject

Respond with strict JSON only, no other text, no markdown fences:
{"relationship": "contradicts" | "extends" | "independent", "contradictedIndex": <0-based index into EXISTING, or null>}
contradictedIndex must be set only when relationship is "contradicts".`;

/**
 * One extra model call per fact write, run against the nearest existing
 * facts for the same subject. On any ambiguity or parse failure this falls
 * back to "independent" rather than guessing at a supersession — a wrong
 * "independent" leaves both facts retrievable and correctable later, while
 * a wrong "contradicts" destructively (if silently) hides a true fact.
 */
export async function checkConflict(newStatement: string, existingStatements: string[]): Promise<ConflictResult> {
  if (existingStatements.length === 0) {
    return { relationship: "independent", contradictedIndex: null };
  }

  const prompt = `NEW: ${newStatement}\n\nEXISTING:\n${existingStatements
    .map((statement, index) => `${index}. ${statement}`)
    .join("\n")}`;

  try {
    const raw = await ollamaGenerate(CONFLICT_SYSTEM_PROMPT, prompt);
    const cleaned = raw.trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(cleaned) as { relationship?: unknown; contradictedIndex?: unknown };

    if (
      parsed.relationship === "contradicts" ||
      parsed.relationship === "extends" ||
      parsed.relationship === "independent"
    ) {
      const rawIndex = parsed.contradictedIndex;
      const validIndex =
        typeof rawIndex === "number" && Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < existingStatements.length
          ? rawIndex
          : null;
      return {
        relationship: parsed.relationship,
        contradictedIndex: parsed.relationship === "contradicts" ? validIndex : null,
      };
    }
  } catch {
    // fall through to the safe default below
  }

  return { relationship: "independent", contradictedIndex: null };
}

export async function previewForget(target: string): Promise<MemoryRow[]> {
  return db
    .select()
    .from(memories)
    .where(and(ilike(memories.statement, `%${target}%`), eq(memories.status, "active")));
}

export async function executeForget(ids: string[]): Promise<{ deletedCount: number }> {
  if (ids.length === 0) {
    return { deletedCount: 0 };
  }
  const deleted = await db
    .delete(memories)
    .where(inArray(memories.id, ids))
    .returning({ id: memories.id, sourceEventIds: memories.sourceEventIds });

  // A hard-deleted memory's source event(s) must stop resurfacing too -
  // otherwise the raw statement lives on forever via the message search
  // leg (removeEmbedding) or, since that leg isn't the only one that
  // reads raw event text, via retrieval's short recent-events window
  // too (excludedFromContext, checked there).
  for (const row of deleted) {
    for (const eventId of row.sourceEventIds as string[]) {
      await removeEmbedding("events", eventId);
      await addEventMetadata(eventId, { excludedFromContext: true });
    }
  }

  return { deletedCount: deleted.length };
}

export interface MemoryWithWeight extends MemoryRow {
  weight: number;
}

export async function searchMemories(query?: string): Promise<MemoryWithWeight[]> {
  const rows = await db.select().from(memories).where(eq(memories.status, "active")).orderBy(desc(memories.createdAt));
  const now = new Date();

  const withWeight: MemoryWithWeight[] = rows.map((row) => ({
    ...row,
    weight: decayWeight({
      decayClass: row.decayClass as DecayClass,
      lastConfirmedAt: row.lastConfirmedAt,
      now,
      reinforcementCount: row.reinforcementCount,
      validUntil: row.validUntil,
    }),
  }));

  const filtered = query
    ? withWeight.filter((row) => row.statement.toLowerCase().includes(query.toLowerCase()))
    : withWeight;

  return filtered.sort((a, b) => b.weight - a.weight || b.createdAt.getTime() - a.createdAt.getTime());
}
