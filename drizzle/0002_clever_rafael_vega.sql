-- pgvector extension. Already installed on the project's Neon database
-- (verified 2026-05-12; default_version 0.8.0). IF NOT EXISTS keeps fresh
-- environments and re-applied migrations idempotent.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "catalog_item" (
	"inv_mast_uid" integer PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"item_desc" text,
	"extended_desc" text,
	"sales_pricing_unit" text,
	"delete_flag" boolean DEFAULT false NOT NULL,
	"source_modified_at" timestamp with time zone,
	"embed_input_hash" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"embedded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_item_item_id_unique" UNIQUE("item_id")
);
--> statement-breakpoint
-- HNSW index, cosine distance. m=16 and ef_construction=64 are pgvector
-- defaults — fine until there is evidence we need to tune. Created BEFORE
-- the backfill so vectors land in the graph incrementally per-insert rather
-- than as a single rebuild at the end (the graph must fit in
-- maintenance_work_mem to build quickly; on Neon Free that is ~256MB, well
-- below the ~1.5–2GB needed for 99K × 1024 floats + graph overhead).
CREATE INDEX "catalog_item_embedding_idx"
  ON "catalog_item" USING hnsw ("embedding" vector_cosine_ops);
