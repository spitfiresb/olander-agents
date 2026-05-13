// One-time: copy all vectors from the Pinecone serverless index to the
// Qdrant Cloud collection. Idempotent at the point level (upsert overwrites
// by ID) — re-running is safe. No Voyage embedding calls.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/migrate-pinecone-to-qdrant.ts
//
// Reads from Pinecone via listPaginated + fetch, writes to Qdrant via
// upsertCatalogPoints. The Pinecone record id is a stringified inv_mast_uid;
// we parse it back to a number for the Qdrant point id (uint64 point ids are
// the more efficient form on the Qdrant side).
//
// Run scripts/create-qdrant-collection.ts first so the destination
// collection exists with the right shape.

import {
  getPineconeClient,
  PINECONE_INDEX_NAME,
} from "../src/lib/ai/pinecone";
import {
  upsertCatalogPoints,
  type CatalogVectorPayload,
  QDRANT_COLLECTION,
  getQdrantClient,
} from "../src/lib/ai/qdrant";

const LIST_PAGE = 100; // Pinecone listPaginated returns up to 100 ids/page
const FETCH_BATCH = 100; // Pinecone fetch caps at 1000 ids per call; 100 is plenty
const UPSERT_BATCH = 200; // Qdrant upsert is happy with 100–500 points/batch

type PineconeFetchRecord = {
  id: string;
  values?: number[];
  metadata?: Record<string, unknown>;
};

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function toPayload(md: Record<string, unknown> | undefined): CatalogVectorPayload {
  const m = md ?? {};
  return {
    item_id: asString(m.item_id) ?? "",
    item_desc: asString(m.item_desc) ?? "",
    ...(asString(m.extended_desc)
      ? { extended_desc: asString(m.extended_desc) as string }
      : {}),
    ...(asString(m.sales_pricing_unit)
      ? { sales_pricing_unit: asString(m.sales_pricing_unit) as string }
      : {}),
    delete_flag: m.delete_flag === true,
  };
}

async function main() {
  const pc = getPineconeClient().index(PINECONE_INDEX_NAME);
  const qd = getQdrantClient();

  const before = await qd.getCollection(QDRANT_COLLECTION);
  console.log(
    `[migrate] qdrant "${QDRANT_COLLECTION}" pre-migration: ${before.points_count ?? 0} points`,
  );

  let paginationToken: string | undefined = undefined;
  let copied = 0;
  let pageNum = 0;
  const start = Date.now();

  while (true) {
    pageNum += 1;
    const page = await pc.listPaginated({
      limit: LIST_PAGE,
      ...(paginationToken ? { paginationToken } : {}),
    });
    const ids = (page.vectors ?? [])
      .map((v) => v.id)
      .filter((id): id is string => typeof id === "string");
    paginationToken = page.pagination?.next;

    if (ids.length === 0) {
      if (!paginationToken) break;
      continue;
    }

    // Fetch full records in sub-batches; flatten into Qdrant points.
    const points: Array<{
      id: number;
      vector: number[];
      payload: CatalogVectorPayload;
    }> = [];
    for (let i = 0; i < ids.length; i += FETCH_BATCH) {
      const slice = ids.slice(i, i + FETCH_BATCH);
      const fetched = await pc.fetch({ ids: slice });
      const records = (fetched.records ?? {}) as Record<
        string,
        PineconeFetchRecord
      >;
      for (const id of slice) {
        const r = records[id];
        if (!r?.values || r.values.length === 0) {
          console.warn(`[migrate] skipping ${id}: no vector`);
          continue;
        }
        const numId = Number(id);
        if (!Number.isFinite(numId)) {
          console.warn(`[migrate] skipping ${id}: non-numeric id`);
          continue;
        }
        points.push({
          id: numId,
          vector: r.values,
          payload: toPayload(r.metadata),
        });
      }
    }

    // Qdrant upsert in sub-batches.
    for (let i = 0; i < points.length; i += UPSERT_BATCH) {
      const batch = points.slice(i, i + UPSERT_BATCH);
      await upsertCatalogPoints(batch);
      copied += batch.length;
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(
      `[migrate] page=${pageNum} copied=${copied} elapsed=${elapsed}s ${paginationToken ? "more…" : "last page"}`,
    );

    if (!paginationToken) break;
  }

  // Wait briefly for Qdrant's index to settle before reporting the final count.
  await new Promise((r) => setTimeout(r, 1500));
  const after = await qd.getCollection(QDRANT_COLLECTION);
  console.log(
    `[migrate] done: copied=${copied} qdrant_points=${after.points_count ?? 0} ` +
      `elapsed=${((Date.now() - start) / 1000).toFixed(1)}s`,
  );
}

main().catch((err) => {
  console.error("[migrate] FAILED:", err);
  process.exit(1);
});
