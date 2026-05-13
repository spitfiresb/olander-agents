// One-time: copy the existing Neon `catalog_item.embedding` vectors and
// metadata to the Pinecone serverless index. Idempotent at the record level
// (Pinecone upsert overwrites by ID) — re-running is safe. No Voyage calls.
//
// Usage:
//   npx tsx scripts/migrate-neon-to-pinecone.ts
//
// Uses raw SQL via the neon-http driver so this script does not depend on
// the live Drizzle schema (the `embedding` column gets dropped right after
// this script lands, and Drizzle's schema is the spec — not the current DB
// state). After this completes successfully, run drizzle-kit migrate to
// drop the column.

import { config } from "dotenv";
config({ path: ".env.local", override: true });

const NEON_PAGE = 1000;
const UPSERT_BATCH = 100;

type Row = {
  inv_mast_uid: number;
  item_id: string;
  item_desc: string | null;
  extended_desc: string | null;
  sales_pricing_unit: string | null;
  delete_flag: boolean;
  embedding: string; // pgvector text repr: "[a,b,c,…]"
};

function parseVector(literal: string): number[] {
  const trimmed = literal.replace(/^\[/, "").replace(/\]$/, "");
  if (trimmed.length === 0) return [];
  return trimmed.split(",").map(Number);
}

async function main() {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL!);
  const { getCatalogIndex, vectorIdFor, getPineconeClient, PINECONE_INDEX_NAME } =
    await import("@/lib/ai/pinecone");
  const index = getCatalogIndex();

  let cursor = -1;
  let copied = 0;
  const start = Date.now();

  while (true) {
    // Raw SQL — cast embedding to text so the neon-http driver round-trips
    // it as a string we can parse client-side.
    const rows = (await sql`
      SELECT inv_mast_uid, item_id, item_desc, extended_desc,
             sales_pricing_unit, delete_flag, embedding::text AS embedding
        FROM catalog_item
       WHERE inv_mast_uid > ${cursor}
       ORDER BY inv_mast_uid ASC
       LIMIT ${NEON_PAGE}
    `) as Row[];

    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].inv_mast_uid;

    const records = rows.map((r) => ({
      id: vectorIdFor(r.inv_mast_uid),
      values: parseVector(r.embedding),
      metadata: {
        item_id: r.item_id,
        item_desc: r.item_desc ?? "",
        ...(r.extended_desc ? { extended_desc: r.extended_desc } : {}),
        ...(r.sales_pricing_unit
          ? { sales_pricing_unit: r.sales_pricing_unit }
          : {}),
        delete_flag: r.delete_flag,
      },
    }));

    // Guard: skip rows where embedding somehow parsed empty rather than
    // sending an empty values array to Pinecone (it would reject).
    const valid = records.filter((r) => r.values.length > 0);
    if (valid.length !== records.length) {
      console.warn(
        `[migrate] skipping ${records.length - valid.length} rows with empty embeddings`,
      );
    }

    for (let i = 0; i < valid.length; i += UPSERT_BATCH) {
      const batch = valid.slice(i, i + UPSERT_BATCH);
      if (batch.length === 0) continue;
      // Pinecone SDK v7 takes `{ records: [...] }`, not a bare array — earlier
      // versions accepted the array directly. The validator's "Must pass in
      // at least 1 record" error fires when records is undefined.
      await index.upsert({ records: batch });
      copied += batch.length;
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(
      `[migrate] copied=${copied} cursor=${cursor} elapsed=${elapsed}s`,
    );
    if (rows.length < NEON_PAGE) break;
  }

  const pc = getPineconeClient();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const stats = await pc.index(PINECONE_INDEX_NAME).describeIndexStats();
    const total = stats.totalRecordCount ?? 0;
    console.log(`[migrate] pinecone reports ${total} total records`);
    if (total >= copied * 0.95) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(
    `[migrate] done: ${copied} rows in ${((Date.now() - start) / 1000).toFixed(1)}s`,
  );
}

main().catch((err) => {
  console.error("[migrate] FAILED:", err);
  process.exit(1);
});
