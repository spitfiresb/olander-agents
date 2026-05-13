// Shared Pinecone client + index handle.
//
// Single source of truth for the index name, dimensions, metric, region, and
// metadata shape. The catalog vector index lives in Pinecone (Free serverless,
// AWS us-east-1, ~2 GB cap — plenty of headroom for Olander's ~99K rows at
// 1024 dims). The row metadata + dedupe hash still live in Neon Postgres in
// `catalog_item` (see src/db/schema.ts). See RETRIEVAL.md § Vector store.

import { Pinecone, type Index } from "@pinecone-database/pinecone";

export const PINECONE_INDEX_NAME =
  process.env.PINECONE_INDEX_NAME ?? "olander-catalog";
export const PINECONE_REGION = "us-east-1";
export const PINECONE_CLOUD = "aws";
export const PINECONE_DIM = 1024;
export const PINECONE_METRIC = "cosine" as const;

// Metadata stored alongside each vector. Kept narrow on purpose — Pinecone's
// per-record metadata cap is 40 KB and counts toward index storage. We
// duplicate the small descriptive fields here so searchCatalog can return
// useful results in one round-trip without a Neon join.
export type CatalogVectorMetadata = {
  item_id: string;
  item_desc: string;
  extended_desc?: string;
  sales_pricing_unit?: string;
  delete_flag: boolean;
};

let cachedClient: Pinecone | null = null;
let cachedIndex: Index<CatalogVectorMetadata> | null = null;

export function getPineconeClient(): Pinecone {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.PINECONE_API_KEY?.trim();
  if (!apiKey) throw new Error("PINECONE_API_KEY is not set");
  cachedClient = new Pinecone({ apiKey });
  return cachedClient;
}

export function getCatalogIndex(): Index<CatalogVectorMetadata> {
  if (cachedIndex) return cachedIndex;
  cachedIndex = getPineconeClient().index<CatalogVectorMetadata>(
    PINECONE_INDEX_NAME,
  );
  return cachedIndex;
}

/** Pinecone record IDs must be strings. We key on inv_mast_uid because it
 * is stable across P21 item_id changes (rare, but documented in RETRIEVAL.md
 * § Schema). */
export function vectorIdFor(invMastUid: number): string {
  return String(invMastUid);
}

export function pineconeConfigured(): boolean {
  return Boolean(process.env.PINECONE_API_KEY);
}
