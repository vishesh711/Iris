import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  smallint,
  boolean,
  integer,
  vector,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Append-only ledger: every Telegram message, ingested email, calendar
// change, agent observation, action, and correction lands here.
// Nothing is ever mutated; corrections are new rows, not updates.
export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: text("source").notNull(),
  type: text("type").notNull(),
  rawData: jsonb("raw_data").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  metadata: jsonb("metadata"),
});

// Facts, preferences, entities, and relations extracted from events.
// certainty is ordinal ('asserted' | 'inferred' | 'contradicted'), never a
// float a model isn't calibrated to produce. Decay is computed at query
// time from decay_class + last_confirmed_at (see src/lib/decay.ts) and is
// never stored here. Nothing is deleted on correction: status moves to
// 'superseded' and supersedes points at the row it replaces.
export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    statement: text("statement").notNull(),
    subject: text("subject"),
    predicate: text("predicate"),
    object: text("object"),
    certainty: text("certainty").notNull(),
    reinforcementCount: integer("reinforcement_count").notNull().default(1),
    sourceEventIds: jsonb("source_event_ids").notNull(),
    decayClass: text("decay_class").notNull(),
    status: text("status").notNull().default("active"),
    supersedes: uuid("supersedes").references((): AnyPgColumn => memories.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }).notNull().defaultNow(),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    embedding: vector("embedding", { dimensions: 384 }),
  },
  (table) => ({
    subjectStatusIdx: index("memories_subject_status_idx").on(table.subject, table.status),
  })
);

// The center of the permission system. The planner never calls a
// side-effecting tool directly — it writes a row here, the policy gate
// decides approved/queued/denied, and (from Milestone 6 on) a separate
// executor drains approved rows. idempotency_key prevents a crash between
// a successful side effect and the status write from resending on restart.
export const actions = pgTable(
  "actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tool: text("tool").notNull(),
    args: jsonb("args").notNull(),
    rationale: text("rationale"),
    tier: smallint("tier").notNull(),
    status: text("status").notNull(),
    sourceEventId: uuid("source_event_id").references(() => events.id),
    untrusted: boolean("untrusted").notNull().default(false),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    undoPayload: jsonb("undo_payload"),
    result: jsonb("result"),
    proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
  },
  (table) => ({
    statusTierIdx: index("actions_status_tier_idx")
      .on(table.status, table.tier)
      .where(sql`${table.status} in ('proposed', 'approved')`),
  })
);

// People, companies, and other things emails/calendar events reference.
// `type` (e.g. "recruiter") is what several detectors key on downstream.
export const entities = pgTable("entities", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  aliases: jsonb("aliases"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const relations = pgTable("relations", {
  id: uuid("id").primaryKey().defaultRandom(),
  fromEntityId: uuid("from_entity_id").references(() => entities.id),
  toEntityId: uuid("to_entity_id").references(() => entities.id),
  relationType: text("relation_type"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Read-only Gmail ingest. message_id is unique so polling (which Gmail's
// history API redelivers constantly) is a plain upsert, never a duplicate.
export const emails = pgTable("emails", {
  id: uuid("id").primaryKey().defaultRandom(),
  messageId: text("message_id").notNull().unique(),
  threadId: text("thread_id"),
  fromAddress: text("from_address"),
  fromName: text("from_name"),
  toAddresses: jsonb("to_addresses"),
  subject: text("subject"),
  snippet: text("snippet"),
  bodyText: text("body_text"),
  labels: jsonb("labels"),
  entityId: uuid("entity_id").references(() => entities.id),
  receivedAt: timestamp("received_at", { withTimezone: true }),
  raw: jsonb("raw"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Read-only Calendar ingest, same upsert-on-provider-id discipline.
export const calendarEvents = pgTable("calendar_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerId: text("provider_id").notNull().unique(),
  calendarId: text("calendar_id"),
  title: text("title"),
  description: text("description"),
  location: text("location"),
  startAt: timestamp("start_at", { withTimezone: true }),
  endAt: timestamp("end_at", { withTimezone: true }),
  allDay: boolean("all_day"),
  attendees: jsonb("attendees"),
  status: text("status"),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
  raw: jsonb("raw"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Small persistent watermark store: Gmail's historyId, Calendar's
// syncToken, and each source's last successful/failed poll, so the debug
// UI can show sync lag and ingest can resume incrementally after a
// restart instead of re-backfilling from scratch.
export const syncState = pgTable("sync_state", {
  key: text("key").primaryKey(),
  value: jsonb("value"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
