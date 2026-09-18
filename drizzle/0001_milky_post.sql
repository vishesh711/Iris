CREATE TABLE "actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tool" text NOT NULL,
	"args" jsonb NOT NULL,
	"rationale" text,
	"tier" smallint NOT NULL,
	"status" text NOT NULL,
	"source_event_id" uuid,
	"untrusted" boolean DEFAULT false NOT NULL,
	"idempotency_key" text NOT NULL,
	"undo_payload" jsonb,
	"result" jsonb,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	CONSTRAINT "actions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"statement" text NOT NULL,
	"subject" text,
	"predicate" text,
	"object" text,
	"certainty" text NOT NULL,
	"reinforcement_count" integer DEFAULT 1 NOT NULL,
	"source_event_ids" jsonb NOT NULL,
	"decay_class" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"supersedes" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"embedding" vector(384)
);
--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_source_event_id_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_supersedes_memories_id_fk" FOREIGN KEY ("supersedes") REFERENCES "public"."memories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "actions_status_tier_idx" ON "actions" USING btree ("status","tier") WHERE "actions"."status" in ('proposed', 'approved');--> statement-breakpoint
CREATE INDEX "memories_subject_status_idx" ON "memories" USING btree ("subject","status");