CREATE TABLE "tool_autonomy_overrides" (
	"tool" text PRIMARY KEY NOT NULL,
	"level" smallint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "undone_at" timestamp with time zone;