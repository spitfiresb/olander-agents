-- Stage 1 + Stage 3 chat-table additions on top of main's 0005.
-- All statements use IF NOT EXISTS (or DO-block guards) so this migration
-- is idempotent: the dev DB already has these columns from an earlier
-- scripts/fix-db-0002.mjs recovery + a prior db:migrate run, so applying
-- here is a clean no-op there. Production gets the columns and indexes
-- applied on first run.
--
-- Two pieces are hand-added on top of what `drizzle-kit generate` emitted
-- because drizzle does not model `tsvector` natively:
--   - the `searchVector` generated column on "message"
--   - the GIN index `msg_search_vector_idx`
-- These live in SQL only; queries reach them via raw `sql` template
-- literals in lib/conversations.searchConversations.

ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "pinnedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "searchText" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Backfill searchText for existing rows by flattening text parts out of
-- the jsonb `parts` array. New rows populate searchText at insert time
-- in lib/conversations.appendMessages, so this UPDATE only matters on
-- a freshly-migrated prod DB; on dev it's a no-op (existing rows are
-- already populated from the prior recovery).
UPDATE "message" SET "searchText" = COALESCE(
  (
    SELECT string_agg(elem->>'text', ' ')
    FROM jsonb_array_elements("parts") elem
    WHERE elem->>'type' = 'text' AND jsonb_typeof(elem->'text') = 'string'
  ),
  ''
) WHERE "searchText" = '';--> statement-breakpoint
-- tsvector generated from searchText. IF NOT EXISTS doesn't apply to
-- generated columns; the DO block guards against re-adding when the
-- column already exists.
DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'message' AND column_name = 'searchVector'
    ) THEN
      ALTER TABLE "message" ADD COLUMN "searchVector" tsvector
        GENERATED ALWAYS AS (to_tsvector('english', "searchText")) STORED;
    END IF;
  END $$;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "supersededAt" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conv_user_pinned_idx" ON "conversation" USING btree ("userId","pinnedAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "msg_search_vector_idx" ON "message" USING gin ("searchVector");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "msg_conv_superseded_idx" ON "message" USING btree ("conversationId","supersededAt");
