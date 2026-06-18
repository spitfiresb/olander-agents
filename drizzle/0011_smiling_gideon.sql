CREATE TABLE "upload_settings" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"max_file_mb" integer DEFAULT 25 NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedBy" text
);
--> statement-breakpoint
-- Seed the singleton row at the 25 MB default. Idempotent; reads fail open to
-- the same default if this is somehow skipped (src/lib/upload-settings.ts).
INSERT INTO "upload_settings" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING;
