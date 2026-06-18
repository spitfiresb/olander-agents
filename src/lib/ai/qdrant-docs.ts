// Qdrant helpers for the reference-document chunk collection (`olander-docs`),
// kept separate from the catalog collection (src/lib/ai/qdrant.ts) because the
// payload shape and lifecycle differ. Reuses the same client, dimension (1024),
// and distance (Cosine) so document and catalog vectors share Voyage 4's space.
//
// One point per chunk. The point id is a random UUID; chunks are grouped by the
// `document_id` payload key so an entire document's chunks can be deleted in one
// filtered call. See docs/Vector_Store.md (a third collection was anticipated).

import {
  QDRANT_DIM,
  QDRANT_DISTANCE,
  getQdrantClient,
  qdrantConfigured,
} from "@/lib/ai/qdrant";

export const QDRANT_DOCS_COLLECTION =
  process.env.QDRANT_DOCS_COLLECTION ?? "olander-docs";

export type DocChunkPayload = {
  document_id: string;
  filename: string;
  chunk_index: number;
  text: string;
};

export type DocMatch = {
  id: string | number;
  score: number;
  payload: Partial<DocChunkPayload>;
};

export function docsConfigured(): boolean {
  return qdrantConfigured();
}

export async function upsertDocChunks(
  points: Array<{ id: string; vector: number[]; payload: DocChunkPayload }>,
): Promise<void> {
  if (points.length === 0) return;
  await getQdrantClient().upsert(QDRANT_DOCS_COLLECTION, {
    wait: true,
    points,
  });
}

export async function searchDocsByVector(
  vector: number[],
  topK: number,
): Promise<DocMatch[]> {
  const res = await getQdrantClient().search(QDRANT_DOCS_COLLECTION, {
    vector,
    limit: topK,
    with_payload: true,
  });
  return res.map((p) => ({
    id: p.id as string | number,
    score: p.score ?? 0,
    payload: (p.payload ?? {}) as Partial<DocChunkPayload>,
  }));
}

// Delete every chunk belonging to one document — by payload filter, so it's one
// call regardless of chunk count. Used when an admin removes a document.
export async function deleteDocChunks(documentId: string): Promise<void> {
  await getQdrantClient().delete(QDRANT_DOCS_COLLECTION, {
    wait: true,
    filter: { must: [{ key: "document_id", match: { value: documentId } }] },
  });
}

export { QDRANT_DIM, QDRANT_DISTANCE };
