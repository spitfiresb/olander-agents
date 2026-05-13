// Shared Qdrant client + collection handle.
//
// Single source of truth for the collection name, dimensions, metric, and
// payload shape. The catalog vector collection lives in Qdrant Cloud (Free
// tier, AWS us-west-1 / Northern California, 4 GB cap — far more than
// Olander's ~99K rows at 1024 dims need). The row metadata + dedupe hash
// still live in Neon Postgres in `catalog_item` (see src/db/schema.ts).
// See docs/Vector_Store.md for the wire contract.

import { QdrantClient } from "@qdrant/js-client-rest";

export const QDRANT_COLLECTION =
  process.env.QDRANT_COLLECTION ?? "olander-catalog";
export const QDRANT_DIM = 1024;
export const QDRANT_DISTANCE = "Cosine" as const;

// Payload stored alongside each vector. Kept narrow on purpose — Qdrant
// payloads are stored on every shard and large payloads slow filtered search.
// We duplicate the small descriptive fields here so searchCatalog can return
// useful results in one round-trip without a Neon join.
export type CatalogVectorPayload = {
  item_id: string;
  item_desc: string;
  extended_desc?: string;
  sales_pricing_unit?: string;
  delete_flag: boolean;
};

let cachedClient: QdrantClient | null = null;

export function getQdrantClient(): QdrantClient {
  if (cachedClient) return cachedClient;
  const url = process.env.QDRANT_URL?.trim();
  const apiKey = process.env.QDRANT_API_KEY?.trim();
  if (!url) throw new Error("QDRANT_URL is not set");
  if (!apiKey) throw new Error("QDRANT_API_KEY is not set");
  // checkCompatibility=false suppresses the client's startup version probe;
  // we don't ship a guarantee about server version and the probe adds a
  // round-trip on every cold start of a serverless function.
  cachedClient = new QdrantClient({ url, apiKey, checkCompatibility: false });
  return cachedClient;
}

/** inv_mast_uid is a uint already, which Qdrant accepts directly as a
 * point id. Stable across P21 item_id changes — see RETRIEVAL.md § Schema. */
export function vectorIdFor(invMastUid: number): number {
  return invMastUid;
}

export function qdrantConfigured(): boolean {
  return Boolean(process.env.QDRANT_URL && process.env.QDRANT_API_KEY);
}

export type CatalogMatch = {
  id: number | string;
  score: number;
  payload: Partial<CatalogVectorPayload>;
};

/** searchCatalog hot path: vector → top-K alive matches with payload.
 * Filters out soft-deleted SKUs unless aliveOnly is explicitly false. */
export async function searchCatalogByVector(
  vector: number[],
  topK: number,
  opts: { aliveOnly?: boolean } = {},
): Promise<CatalogMatch[]> {
  const filter =
    opts.aliveOnly === false
      ? undefined
      : { must: [{ key: "delete_flag", match: { value: false } }] };
  const res = await getQdrantClient().search(QDRANT_COLLECTION, {
    vector,
    limit: topK,
    with_payload: true,
    filter,
  });
  return res.map((p) => ({
    id: p.id as number | string,
    score: p.score ?? 0,
    payload: (p.payload ?? {}) as Partial<CatalogVectorPayload>,
  }));
}

/** Bulk write. `wait: true` blocks until the write is queryable so callers
 * can rely on read-your-write semantics — the sync cron depends on this. */
export async function upsertCatalogPoints(
  points: Array<{
    id: number;
    vector: number[];
    payload: CatalogVectorPayload;
  }>,
): Promise<void> {
  if (points.length === 0) return;
  await getQdrantClient().upsert(QDRANT_COLLECTION, {
    wait: true,
    points: points.map((p) => ({
      id: p.id,
      vector: p.vector,
      payload: p.payload,
    })),
  });
}

/** Metadata-only patch. Used by sync-catalog to flip delete_flag without
 * re-embedding. setPayload merges; it does not replace the whole payload. */
export async function setCatalogPayload(
  id: number,
  payload: Partial<CatalogVectorPayload>,
): Promise<void> {
  await getQdrantClient().setPayload(QDRANT_COLLECTION, {
    wait: true,
    payload,
    points: [id],
  });
}
