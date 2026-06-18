// Single source of truth for reference-document upload limits. Imported by both
// the upload UI (client) and the API routes + ingestion (server), so the two
// gates can never drift out of sync. Pure constants only, with no server-only
// imports, so the client component can read them too.
//
// There are two gates, one per cost:
//   1. SIZE: checked at the door (client + token route). Bounds the only step
//      whose cost scales with raw bytes: downloading + parsing the file.
//   2. WORDS: checked after extraction but BEFORE embedding (the paid step), so
//      an over-long document costs nothing to reject. ~1,000,000 words is a few
//      thousand pages, far beyond any real manual/catalog. It also keeps the
//      embed work inside the ingest route's 300s budget: ~1M words is ~4k chunks
//      and ~50 Voyage calls, with headroom for download + extract + upsert.

export const MAX_DOC_MB = 25;
export const MAX_DOC_BYTES = MAX_DOC_MB * 1024 * 1024;

export const MAX_DOC_WORDS = 1_000_000;

// Scanned-PDF guard (non-blocking warning, not a reject). A PDF with real
// selectable text runs hundreds of words per page; a scanned or image-only PDF
// yields near-zero, and a *partial* scan yields a handful, which would index a
// sliver and still look "Ready". When a PDF of at least SCAN_CHECK_MIN_PAGES
// pages averages fewer than SCAN_MIN_WORDS_PER_PAGE words/page, we flag it so
// the admin knows the index only holds a sliver of its text. The minimum page
// count keeps legitimately short documents (a one-page memo, a cover) from
// tripping it; the threshold is set low so image-heavy-but-labeled catalogs
// (part numbers, captions) clear it. Pure-scan or empty PDFs produce zero chunks
// and hard-fail earlier; this catches the deceptive middle.
export const SCAN_CHECK_MIN_PAGES = 5;
export const SCAN_MIN_WORDS_PER_PAGE = 10;
