ALTER TABLE "conversation" ADD COLUMN "pinnedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "searchText" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Backfill searchText for existing rows by flattening text parts out of the
-- jsonb `parts` array. New rows write searchText at insert time in
-- lib/conversations.appendMessages, so this UPDATE only runs once.
UPDATE "message" SET "searchText" = COALESCE(
  (
    SELECT string_agg(elem->>'text', ' ')
    FROM jsonb_array_elements("parts") elem
    WHERE elem->>'type' = 'text' AND jsonb_typeof(elem->'text') = 'string'
  ),
  ''
) WHERE "searchText" = '';--> statement-breakpoint
-- tsvector column generated from searchText. Drizzle doesn't model tsvector,
-- so this column lives in Postgres only — queries reach it via raw `sql`
-- template literals. `english` config does stemming + stop-words, which fits
-- natural-language chat titles and bodies. SKU-style queries still hit
-- conversation.title via ILIKE in the search query.
ALTER TABLE "message" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', "searchText")) STORED;--> statement-breakpoint
CREATE INDEX "msg_search_vector_idx" ON "message" USING gin ("searchVector");--> statement-breakpoint
CREATE INDEX "conv_user_pinned_idx" ON "conversation" ("userId", "pinnedAt");