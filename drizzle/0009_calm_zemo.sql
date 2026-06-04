-- Trimmed by hand. drizzle-kit re-proposed scope/conversation/message objects
-- that already exist (created in 0006 + 0008) because the meta snapshot had
-- drifted after the PR #8 rebase. Those statements were removed — only the
-- genuinely-new trial_budget table remains. The regenerated 0009 snapshot is
-- complete, so this also realigns the snapshot chain for future migrations.
CREATE TABLE IF NOT EXISTS "trial_budget" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"limit_cents" integer DEFAULT 1000 NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedBy" text
);
--> statement-breakpoint
-- Seed the singleton row so reads never hit an empty table (defaults: $10, on).
INSERT INTO "trial_budget" ("id") VALUES ('singleton') ON CONFLICT DO NOTHING;
