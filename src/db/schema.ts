import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";

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
