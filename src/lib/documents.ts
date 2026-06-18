import { del } from "@vercel/blob";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { referenceDocuments } from "@/db/schema";
import { chunkText, MAX_CHUNKS } from "@/lib/ai/chunk";
import { embedDocuments, embedQuery } from "@/lib/ai/embeddings";
import {
  deleteDocChunks,
  searchDocsByVector,
  upsertDocChunks,
  type DocChunkPayload,
} from "@/lib/ai/qdrant-docs";
import { fetchAndExtractText } from "@/lib/extract";

// Orchestration for the reference-document store. This is the seam the admin UI
// (/admin/documents) and the chat tool (searchDocuments) both build on:
//
//   ingest:   createReferenceDocument → processReferenceDocument
//             (extract text → chunk → embed → upsert to Qdrant)
//   manage:   listReferenceDocuments / deleteReferenceDocument
//   retrieve: searchReferenceDocuments  (used by the searchDocuments tool)
//
// Storage split mirrors the catalog: row metadata in Neon (reference_document),
// chunk vectors in Qdrant (olander-docs), original bytes in Vercel Blob.

export const REFERENCE_DOC_PREFIX = "reference-docs";

// Voyage accepts many inputs per request, but batch to stay well under the
// per-request token ceiling and to upsert incrementally on large documents.
const EMBED_BATCH = 96;

export type ReferenceDocument = typeof referenceDocuments.$inferSelect;

export type DocumentPassage = {
  source: string;
  text: string;
  score: number;
};

export async function listReferenceDocuments(): Promise<ReferenceDocument[]> {
  return db
    .select()
    .from(referenceDocuments)
    .orderBy(desc(referenceDocuments.createdAt));
}

export async function getReferenceDocument(
  id: string,
): Promise<ReferenceDocument | null> {
  const rows = await db
    .select()
    .from(referenceDocuments)
    .where(eq(referenceDocuments.id, id))
    .limit(1);
  return rows[0] ?? null;
}

// Insert the row in 'processing' state. Ingestion runs separately (so the
// upload request can return immediately and the admin UI can poll for status).
export async function createReferenceDocument(input: {
  filename: string;
  mediaType: string;
  sizeBytes: number;
  blobUrl: string;
  blobPathname: string;
  uploadedBy: string | null;
}): Promise<ReferenceDocument> {
  const [row] = await db
    .insert(referenceDocuments)
    .values({
      filename: input.filename,
      mediaType: input.mediaType,
      sizeBytes: input.sizeBytes,
      blobUrl: input.blobUrl,
      blobPathname: input.blobPathname,
      uploadedBy: input.uploadedBy,
      status: "processing",
      chunkCount: 0,
    })
    .returning();
  return row;
}

async function markFailed(id: string, error: string): Promise<void> {
  await db
    .update(referenceDocuments)
    .set({ status: "failed", error: error.slice(0, 1000), updatedAt: new Date() })
    .where(eq(referenceDocuments.id, id));
}

// Extract → chunk → embed → upsert. Idempotent-ish: on re-run it clears any
// prior chunks for this document first so a retry can't duplicate points.
// Updates the row to 'ready' (with chunkCount) or 'failed' (with the reason).
export async function processReferenceDocument(id: string): Promise<void> {
  const doc = await getReferenceDocument(id);
  if (!doc) return;

  try {
    // Clear any partial/previous chunks so a retry is clean.
    await deleteDocChunks(id);

    const text = await fetchAndExtractText(doc.blobUrl, doc.mediaType);
    const chunks = chunkText(text);

    if (chunks.length === 0) {
      await markFailed(
        id,
        "No extractable text — the file may be image-only/scanned (OCR isn't supported yet) or empty. Try a text-based version.",
      );
      return;
    }

    let written = 0;
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const { vectors } = await embedDocuments(batch.map((c) => c.text));
      const points = batch.map((c, j) => ({
        id: crypto.randomUUID(),
        vector: vectors[j],
        payload: {
          document_id: id,
          filename: doc.filename,
          chunk_index: c.index,
          text: c.text,
        } satisfies DocChunkPayload,
      }));
      await upsertDocChunks(points);
      written += points.length;
    }

    await db
      .update(referenceDocuments)
      .set({ status: "ready", chunkCount: written, error: null, updatedAt: new Date() })
      .where(eq(referenceDocuments.id, id));

    if (chunks.length >= MAX_CHUNKS) {
      console.warn(
        `[documents] ${doc.filename} hit the ${MAX_CHUNKS}-chunk cap; tail may be unindexed.`,
      );
    }
  } catch (err) {
    console.error("[documents] ingest failed:", doc.filename, err);
    await markFailed(id, err instanceof Error ? err.message : String(err));
  }
}

// Remove a document everywhere: Qdrant chunks first (so search can't return a
// passage whose source file is gone), then the blob, then the row.
export async function deleteReferenceDocument(id: string): Promise<boolean> {
  const doc = await getReferenceDocument(id);
  if (!doc) return false;
  await deleteDocChunks(id);
  try {
    await del(doc.blobUrl);
  } catch (err) {
    // A missing/already-deleted blob shouldn't block removing the row.
    console.warn("[documents] blob delete warn:", err);
  }
  await db.delete(referenceDocuments).where(eq(referenceDocuments.id, id));
  return true;
}

// Retrieval path used by the searchDocuments chat tool.
export async function searchReferenceDocuments(
  query: string,
  topK: number,
): Promise<DocumentPassage[]> {
  const vector = await embedQuery(query);
  const matches = await searchDocsByVector(vector, topK);
  return matches.map((m) => ({
    source: typeof m.payload.filename === "string" ? m.payload.filename : "",
    text: typeof m.payload.text === "string" ? m.payload.text : "",
    score: m.score,
  }));
}
