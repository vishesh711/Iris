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
const RECENT_EVENTS_LIMIT = 5;

function vectorParam(vector: number[]) {
  return sql`${`[${vector.join(",")}]`}::vector`;
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
  const pattern = `%${query}%`;
  const rows = await db
    .select()
    .from(emails)
    .where(or(ilike(emails.subject, pattern), ilike(emails.bodyText, pattern), ilike(emails.fromAddress, pattern)))
    .orderBy(desc(emails.receivedAt))
    .limit(STRUCTURED_LIMIT);

  return rows.map((row) => ({
    kind: "email" as const,
    text: `From: ${row.fromName ?? row.fromAddress}\nSubject: ${row.subject}\n${row.bodyText ?? row.snippet ?? ""}`,
    score: 1,
    metadata: { emailId: row.id, receivedAt: row.receivedAt },
  }));
}

async function structuredCalendarSearch(query: string): Promise<RetrievedItem[]> {
  const pattern = `%${query}%`;
  const rows = await db
    .select()
    .from(calendarEvents)
    .where(or(ilike(calendarEvents.title, pattern), ilike(calendarEvents.description, pattern)))
    .orderBy(desc(calendarEvents.startAt))
    .limit(STRUCTURED_LIMIT);

  return rows.map((row) => ({
    kind: "calendar_event" as const,
    text: `${row.title ?? ""} — ${row.startAt?.toISOString() ?? "no date"}${row.location ? ` at ${row.location}` : ""}`,
    score: 1,
    metadata: { calendarEventId: row.id },
  }));
}

async function recentEventsContext(): Promise<RetrievedItem[]> {
  const rows = await db.select().from(events).orderBy(desc(events.receivedAt)).limit(RECENT_EVENTS_LIMIT);
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
