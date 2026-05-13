// Diagnostic: verify pgvector is installed, the catalog_item table exists,
// the HNSW index is in place, and how populated the table is.
//
// Run with:  node scripts/check-pgvector.mjs

import { config } from "dotenv";
config({ path: ".env.local" });

const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

const ext = await sql`SELECT extname, extversion FROM pg_extension WHERE extname='vector'`;
console.log("vector extension:", ext);

const cols = await sql`
  SELECT column_name, data_type, udt_name FROM information_schema.columns
   WHERE table_schema='public' AND table_name='catalog_item' ORDER BY ordinal_position`;
console.log(`catalog_item columns (${cols.length}):`);
for (const c of cols) console.log(`  ${c.column_name.padEnd(20)} ${c.udt_name}`);

const idx = await sql`
  SELECT indexname FROM pg_indexes
   WHERE schemaname='public' AND tablename='catalog_item' ORDER BY indexname`;
console.log("indexes:", idx.map((i) => i.indexname));

if (cols.length > 0) {
  const [{ count, alive, deleted, modified }] = await sql`
    SELECT COUNT(*)::int AS count,
           COUNT(*) FILTER (WHERE delete_flag = false)::int AS alive,
           COUNT(*) FILTER (WHERE delete_flag = true)::int AS deleted,
           MAX(source_modified_at) AS modified
      FROM catalog_item`;
  console.log(`rows: ${count} total / ${alive} alive / ${deleted} soft-deleted`);
  console.log(`max(source_modified_at): ${modified ?? "<empty>"}`);
}
