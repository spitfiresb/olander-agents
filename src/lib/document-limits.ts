// Single source of truth for reference-document upload limits. Imported by both
// the upload UI (client) and the API routes + ingestion (server), so the two
// gates can never drift out of sync. Pure constants only — no server-only
// imports — so the client component can read them too.
//
// There are two gates, one per cost:
//   1. SIZE  — checked at the door (client + token route). Bounds the only step
//      whose cost scales with raw bytes: downloading + parsing the file.
//   2. WORDS — checked after extraction but BEFORE embedding (the paid step), so
//      an over-long document costs nothing to reject. ~1,000,000 words ≈ a few
//      thousand pages — far beyond any real manual/catalog. It also keeps the
//      embed work inside the ingest route's 300s budget: ~1M words → ~4k chunks
//      → ~50 Voyage calls, with headroom for download + extract + upsert.

export const MAX_DOC_MB = 25;
export const MAX_DOC_BYTES = MAX_DOC_MB * 1024 * 1024;

export const MAX_DOC_WORDS = 1_000_000;
