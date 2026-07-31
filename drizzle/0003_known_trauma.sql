-- Move the catalog vector index from pgvector-on-Neon to Pinecone serverless.
-- See docs/RETRIEVAL.md § Vector store for the history. The HNSW index lives on
-- the embedding column, so it must be dropped first.
--
-- Apply only after scripts/migrate-neon-to-pinecone.ts has finished copying
-- the existing vectors into Pinecone, or you lose the data.
DROP INDEX IF EXISTS "catalog_item_embedding_idx";
--> statement-breakpoint
ALTER TABLE "catalog_item" DROP COLUMN "embedding";
