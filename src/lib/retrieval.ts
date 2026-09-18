import { and, desc, eq, ilike, isNotNull, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { calendarEvents, embeddings, emails, events, memories } from "../db/schema.js";
import { decayWeight, type DecayClass } from "./decay.js";
import { embedText } from "./embeddings.js";

export interface RetrievedItem {
  kind: "memory" | "message" | "email" | "calendar_event" | "recent_event";
  text: string;
  score: number;
  metadata: Record<string, unknown>;
}

const SEMANTIC_LIMIT = 8;
const MEMORY_LIMIT = 8;
const STRUCTURED_LIMIT = 5;
const STRUCTURED_CANDIDATE_LIMIT = 30;
const RECENT_EVENTS_LIMIT = 5;

function vectorParam(vector: number[]) {
  return sql`${`[${vector.join(",")}]`}::vector`;
}

// Common words that would otherwise turn every question into an ILIKE
// scan for near-meaningless terms. Not exhaustive — just enough to keep
// the structured legs useful for real questions instead of matching on
// "what", "the", "did", etc.
const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "to", "of", "in", "on", "at", "for",
  "and", "or", "but", "who", "what", "when", "where", "why", "how", "that", "this", "these", "those", "did",
  "do", "does", "i", "me", "my", "you", "your", "about", "with", "from", "it", "its", "as", "by", "if", "so",
  "than", "then", "there", "their", "them", "he", "she", "his", "her", "we", "us", "our", "not", "no", "yes",
  "have", "has", "had", "will", "would", "can", "could", "should", "which",
]);

/**
 * ILIKE against the raw question would only ever match an email/event
 * containing that exact sentence, so structured search extracts
 * meaningful keywords first and matches on any of them instead.
 */
export function extractKeywords(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 2 && !STOPWORDS.has(word))
    )
  );
}

/** How many of the given keywords appear in text, case-insensitively. */
export function countKeywordMatches(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.reduce((count, word) => count + (lower.includes(word) ? 1 : 0), 0);
}

async function semanticSearch(queryVector: number[]): Promise<RetrievedItem[]> {
  const distance = sql<number>`${embeddings.vector} <=> ${vectorParam(queryVector)}`;

  const rows = await db
    .select({
      sourceTable: embeddings.sourceTable,
      sourceId: embeddings.sourceId,
      content: embeddings.content,
      distance,
    })
    .from(embeddings)
    .orderBy(distance)
    .limit(SEMANTIC_LIMIT);

  return rows.map((row) => ({
    kind: row.sourceTable === "emails" ? "email" : "message",
    text: row.content ?? "",
    score: 1 - row.distance,
    metadata: { sourceTable: row.sourceTable, sourceId: row.sourceId },
  }));
}

/**
 * The PRD's explicit ranking rule: prefer the newest non-superseded fact
 * over the most semantically similar one. Superseded memories are
 * excluded entirely by the status='active' filter — never merely
 * down-ranked, since there's no case where a corrected fact should win.
 * Within the remaining active set, similarity is blended with decay
 * weight so a long-stale-but-technically-active memory doesn't outrank a
 * fresher, equally relevant one.
 */
async function memorySearch(queryVector: number[]): Promise<RetrievedItem[]> {
  const distance = sql<number>`${memories.embedding} <=> ${vectorParam(queryVector)}`;

  const rows = await db
    .select({
      id: memories.id,
      statement: memories.statement,
      subject: memories.subject,
      decayClass: memories.decayClass,
      lastConfirmedAt: memories.lastConfirmedAt,
      reinforcementCount: memories.reinforcementCount,
      validUntil: memories.validUntil,
      createdAt: memories.createdAt,
      distance,
    })
    .from(memories)
    .where(and(eq(memories.status, "active"), isNotNull(memories.embedding)))
    .orderBy(distance)
    .limit(MEMORY_LIMIT);

  const now = new Date();

  return rows
    .map((row) => {
      const similarity = 1 - row.distance;
      const weight = decayWeight({
        decayClass: row.decayClass as DecayClass,
        lastConfirmedAt: row.lastConfirmedAt,
        now,
        reinforcementCount: row.reinforcementCount,
        validUntil: row.validUntil,
      });
      return {
        kind: "memory" as const,
        text: row.statement,
        score: similarity * weight,
        metadata: { id: row.id, subject: row.subject, createdAt: row.createdAt },
      };
    })
    .sort((a, b) => b.score - a.score);
}

async function structuredEmailSearch(query: string): Promise<RetrievedItem[]> {
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return [];

  const conditions = keywords.flatMap((word) => {
    const pattern = `%${word}%`;
    return [ilike(emails.subject, pattern), ilike(emails.bodyText, pattern), ilike(emails.fromAddress, pattern)];
  });

  // Recency alone isn't relevance: a genuinely relevant older email
  // (matching every keyword) would otherwise lose out to a flood of
  // newer emails that happen to match just one common keyword (e.g. a
  // recruiting-rejection email matching "role"). Pull a larger candidate
  // pool ordered by recency, then re-rank by how many keywords each one
  // actually matches, keeping recency only as a tiebreaker.
  const candidates = await db
    .select()
    .from(emails)
    .where(or(...conditions))
    .orderBy(desc(emails.receivedAt))
    .limit(STRUCTURED_CANDIDATE_LIMIT);

  return candidates
    .map((row) => ({
      row,
      matchCount: countKeywordMatches(`${row.subject ?? ""} ${row.bodyText ?? ""} ${row.fromAddress ?? ""}`, keywords),
    }))
    .sort((a, b) => b.matchCount - a.matchCount)
    .slice(0, STRUCTURED_LIMIT)
    .map(({ row, matchCount }) => ({
      kind: "email" as const,
      text: `From: ${row.fromName ?? row.fromAddress}\nSubject: ${row.subject}\n${row.bodyText ?? row.snippet ?? ""}`,
      score: matchCount / keywords.length,
      metadata: { emailId: row.id, receivedAt: row.receivedAt },
    }));
}

async function structuredCalendarSearch(query: string): Promise<RetrievedItem[]> {
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return [];

  const conditions = keywords.flatMap((word) => {
    const pattern = `%${word}%`;
    return [ilike(calendarEvents.title, pattern), ilike(calendarEvents.description, pattern)];
  });

  const candidates = await db
    .select()
    .from(calendarEvents)
    .where(or(...conditions))
    .orderBy(desc(calendarEvents.startAt))
    .limit(STRUCTURED_CANDIDATE_LIMIT);

  return candidates
    .map((row) => ({
      row,
      matchCount: countKeywordMatches(`${row.title ?? ""} ${row.description ?? ""}`, keywords),
    }))
    .sort((a, b) => b.matchCount - a.matchCount)
    .slice(0, STRUCTURED_LIMIT)
    .map(({ row, matchCount }) => ({
      kind: "calendar_event" as const,
      text: `${row.title ?? ""} — ${row.startAt?.toISOString() ?? "no date"}${row.location ? ` at ${row.location}` : ""}`,
      score: matchCount / keywords.length,
      metadata: { calendarEventId: row.id },
    }));
}

async function recentEventsContext(): Promise<RetrievedItem[]> {
  // A forgotten or superseded fact's raw source message must not
  // resurface here either — removeEmbedding() (memory.ts/extract-memory.ts)
  // already keeps it out of the semantic search leg, but this leg reads
  // events directly rather than via embeddings, so it needs its own
  // exclusion on the same excludedFromContext flag.
  const rows = await db
    .select()
    .from(events)
    .where(sql`(${events.metadata}->>'excludedFromContext') is distinct from 'true'`)
    .orderBy(desc(events.receivedAt))
    .limit(RECENT_EVENTS_LIMIT);
  return rows.map((row) => ({
    kind: "recent_event" as const,
    text: JSON.stringify(row.rawData).slice(0, 300),
    score: 0.5,
    metadata: { eventId: row.id, type: row.type, receivedAt: row.receivedAt },
  }));
}

/**
 * Merges four retrieval legs: semantic search over embedded
 * messages/emails, memory search (decay + recency ranked), structured
 * keyword search over emails/calendar (catches exact terms embeddings
 * can miss), and recent events for conversational continuity.
 */
export async function retrieve(query: string): Promise<RetrievedItem[]> {
  const queryVector = await embedText(query);

  const [memoryHits, semanticHits, emailHits, calendarHits, recent] = await Promise.all([
    memorySearch(queryVector),
    semanticSearch(queryVector),
    structuredEmailSearch(query),
    structuredCalendarSearch(query),
    recentEventsContext(),
  ]);

  return [...memoryHits, ...semanticHits, ...emailHits, ...calendarHits, ...recent];
}
