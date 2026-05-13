-- IF NOT EXISTS: the original `0002_special_lester` (since renumbered to this
-- file post-merge) was already applied to the shared Neon DB, so the table
-- exists there. Idempotent CREATE keeps this safe to re-run anywhere.
CREATE TABLE IF NOT EXISTS "member" (
	"email" text PRIMARY KEY NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"addedBy" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Backfill: everyone who already has an account becomes a plain member, so the
-- switch from a domain allowlist to a per-email allowlist doesn't lock anyone
-- out who is currently signed in. On a fresh DB "user" is empty -> no-op.
INSERT INTO "member" ("email", "role", "createdAt")
SELECT lower("email"), 'user', now() FROM "user" WHERE "email" IS NOT NULL
ON CONFLICT ("email") DO NOTHING;
--> statement-breakpoint
-- Bootstrap admins (setup decision 2026-05-12). Without at least one admin
-- nobody could ever add members. Editable later via /admin/members.
INSERT INTO "member" ("email", "role", "createdAt") VALUES
	('arankine@uoregon.edu', 'admin', now()),
	('zsaeed@uoregon.edu', 'admin', now()),
	('jsoc@uoregon.edu', 'admin', now())
ON CONFLICT ("email") DO UPDATE SET "role" = 'admin';
--> statement-breakpoint
-- Make their existing user rows admin immediately (otherwise the promotion is
-- only applied on their next login, via the events.signIn reconciler).
UPDATE "user" SET "role" = 'admin'
WHERE lower("email") IN ('arankine@uoregon.edu', 'zsaeed@uoregon.edu', 'jsoc@uoregon.edu');
