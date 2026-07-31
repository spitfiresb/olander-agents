# Retrieval — Catalog Vector Index (and beyond)

> **Status:** shipped. Vector store is Qdrant Cloud (1024d cosine, AWS us-west-1 / Northern California), ~99K catalog rows. Owner: Alex.
> **One-line goal:** add a semantic-search entry point over the P21 parts catalog so reps can describe a part in their own words and get a hit in <300ms, without replacing the existing structured tools.
> **Non-goal:** rebuild P21 as a graph. P21 already is one — see [§ Why not graph RAG](#why-not-graph-rag).

## What this changes

Today (`src/lib/ai/tools.ts`) the chatbot has two tools — `viewsQuery` (OData filter) and `entityGet` (single record by ID). Both go live to P21 every call. They're great for "ACME's last 10 orders" (structured) and bad for "M10 stainless cap screw, around 50mm" (fuzzy). The fuzzy path today devolves into the model guessing `substringof('M10', item_desc)` against a 100-column wide view through two network hops.

This plan adds **one new tool** — `searchCatalog` — backed by a Qdrant Cloud vector collection (1024d cosine, AWS us-west-1), populated from `p21_view_inv_mast` by a backfill + nightly incremental script. Row metadata + dedupe hash live in `catalog_item` on Neon. The existing tools stay; the model picks `searchCatalog` for descriptive queries and chains into `viewsQuery` / `entityGet` for the structured follow-ups (stock, pricing, order history).

## Why we're doing this now

Three reasons, in priority order:

1. **Latency.** Vercel → droplet → P21 round-trip is ~500-1500ms because P21 is slow and the SQL views are wide. Vercel → Qdrant is ~5-15ms (both in us-west). For the *most common* rep workflow ("find the part, then check stock") we shave a full second off the entry-point query and the model still has time to make a structured follow-up call.
2. **Recall.** OData `substringof` and `startswith` are literal string matchers. Reps describe parts in many different orders ("stainless M10 cap screw" vs. "M10 SS hex cap"). Embeddings collapse all of those into the same neighborhood.
3. **Foundation for unstructured docs.** Vendor spec sheets, MSDSs, customer correspondence — all coming later. Building the vector pipeline now against structured P21 data (where we can verify "did the right SKU come back?") de-risks the harder unstructured pass that follows.

## Scope (and what's deliberately out)

### In scope (Phase 1 — this plan)

- One new table, `catalog_item`, holding a denormalized projection of `p21_view_inv_mast` plus the dedupe hash. No embedding column — vectors live in Qdrant.
- One Qdrant collection (`olander-catalog`, 1024d cosine, AWS us-west-1) keyed on `inv_mast_uid`.
- Backfill script: full re-population from P21, content-hash gated so re-runs are idempotent.
- Incremental script: daily polling on `date_last_modified` (verified live — this is the actual column name on `p21_view_inv_mast`, not `date_modified` or `last_maint_date`).
- New embed-and-search wrapper in `src/lib/ai/`.
- New `searchCatalog` tool exposed alongside `viewsQuery` and `entityGet`.
- System-prompt update teaching the model when to use the new tool.

### Out of scope

- **Embedding orders / order lines.** Nobody fuzzy-searches order #S00099912; that's a structured lookup. Adding millions of order-line embeddings would 10x the storage and embedding cost for almost zero query value.
- **Embedding customers.** Maybe later — fuzzy customer name matching ("that aerospace shop in Kent") is a real use case, but the customer set is small enough that `substringof` against `p21_view_customer` already works fine. Revisit if reps actually hit this wall.
- **Replacing `viewsQuery` or `entityGet`.** They stay. `searchCatalog` is additive.
- **Unstructured documents (spec sheets, PDFs).** Phase 2 — same vector store, new chunking pipeline, separate tool. Tracked under [§ Future phases](#future-phases).
- **Re-ranking models.** Voyage and Cohere both offer cross-encoder re-rankers (Voyage's `rerank-2.5`, Cohere's Rerank API). Probably worth it eventually, but ship the baseline first and measure recall before adding latency.

## Defended decisions

### Vector store: Qdrant Cloud (catalog) + Neon Postgres (everything else)

**Decision:** Qdrant Cloud for the catalog vector collection, Neon Postgres for the row metadata, dedupe hash, and the rest of the app data.

**Why this split:**
- 99K rows × 1024-dim vectors × 4 bytes ≈ 400 MB raw, plus HNSW graph overhead ≈ **~700 MB total** — pushes past Neon Free's 500 MB cap. Keeping vectors out of Neon means the app DB's storage curve stays dominated by user-shaped data (auth, chat history, future documents), not by a fixed-size catalog.
- Storage is the binding constraint, not query latency. Voyage queries are already <100ms; Qdrant adds ~5-15ms — imperceptible to a rep on the phone.
- Qdrant Cloud Free tier (4 GB, 1 cluster, forever, no card) covers ~1M @ 1024d uncompressed. Olander's full catalog sits at ~700 MB with ~5× headroom.
- Qdrant's payload duplicates the small descriptive fields (`item_id`, `item_desc`, `extended_desc`, `sales_pricing_unit`, `delete_flag`) so `searchCatalog` returns useful results in a single round-trip — no Neon join at query time.
- AWS us-west-1 (Northern California) puts Qdrant ~5-15ms from the `sfo1` Vercel functions.

**What Neon still holds:**
- `catalog_item` row metadata (same columns, no `embedding`). This is the dedupe-by-hash source of truth — backfill and sync both `SELECT (uid, hash, deleteFlag) WHERE uid IN (...)` to decide what to re-embed.
- All other app tables (auth, conversations, messages, toolCall).

**Write order (load-bearing):** Qdrant first, then Neon. If Qdrant fails, the Neon hash stays stale, so the next sync retries the batch. Reversing the order would create rows that *claim* to be embedded while Qdrant has no vector — silently missing from search until the row's text changes again.

**Soft-delete:** `delete_flag = true` lives in Neon's row (audit trail) AND in Qdrant's payload (filtered at query time with `{ must: [{ key: 'delete_flag', match: { value: false } }] }`). Never a hard delete.

**When we'd revisit:** Qdrant Free's 4 GB cap is ~1M vectors at 1024d. If we ever index millions of order-line or document chunks, the paid tier starts being worth comparing against alternatives. Not today.

### Embedding model: asymmetric Voyage 4 (large for docs, lite for queries)

**Decision:** **voyage-4-large** (1024 dims, default) for document embedding in the backfill and sync scripts. **voyage-4-lite** (1024 dims, shared embedding space) for query embedding in the `searchCatalog` tool. Both accessed via **Voyage's direct API** (`api.voyageai.com`), not through Vercel AI Gateway. Anthropic Claude chat completions continue to route through Vercel Gateway as before.

**Why asymmetric, not symmetric:**

Voyage 4 (released January 2026) introduced a shared embedding space across the entire family. Vectors from voyage-4-large, voyage-4, voyage-4-lite, and voyage-4-nano live in the same 1024-dim space and are directly comparable. That unlocks asymmetric retrieval as the standard pattern: spend on quality where it compounds (documents, embedded once, queried forever), spend on speed where it matters (queries, embedded on the hot request path).

**Why voyage-4-large for documents:**
- Document quality compounds across every future query. A better representation of "M4 X 4 SOC SHOULDER SCREW SST" pays off forever; a better query embedding is thrown away after one search.
- Voyage's MoE architecture in voyage-4-large delivers flagship retrieval at roughly 40% lower serving cost than comparable dense models (Voyage-reported, take with a grain of salt until third-party MTEB submissions catch up).
- Voyage's first 200M tokens are free per account across the entire Voyage 4 family. A 200K-row backfill is ~24M tokens. Even at voyage-4-large's $0.12/MTok list price, this entire project sits inside the free tier.

**Why voyage-4-lite for queries:**
- Queries run on the hot path. Latency budget for `searchCatalog` is <300ms total. A heavier model on the embed step (likely 150-250ms vs ~50-80ms for lite) eats most of that.
- Query embeddings are throwaway. The quality lift from a bigger model on a 30-token query is small, and the structured chain downstream (`viewsQuery` for stock) doesn't care which top-K candidates came back, only that the right ones are in there.
- $0.02/MTok at scale, sits inside the free tier for years at projected traffic.

**Why not voyage-4 (mid-tier) on both sides:**
The shared embedding space collapses the value of "balanced." If both ends speak the same language, pick the strongest for the path that compounds (docs) and the cheapest for the path that runs forever (queries). Voyage-4 in the middle gives up document quality without buying query latency.

**Why direct Voyage API, not Vercel AI Gateway:**

The credit pools are separate, and the workloads cost wildly different amounts per token. Routing embeddings through Vercel burns the shared promotional credit pool on the cheap workload, leaving less headroom for the workload where credits actually matter (Claude chat completions).

- Embeddings: ~$0.02/MTok (queries) to ~$0.12/MTok (documents). Voyage's 200M free tokens per account covers this entire project for years at projected volume. Free tier sits in a dedicated pool, independent of anything else.
- Claude chat completions: roughly $3-15/MTok input plus output tokens. Eats Vercel credits 50-150x faster per token than embeddings do. This is where the Gateway's free credits earn their keep.

Mixing them in the same Gateway pool means every voyage-4-large document embedding competes with Claude tokens for the same free-credit dollar. Splitting them means embeddings live entirely inside Voyage's free tier (effectively cost-zero) and Vercel credits stay reserved for the workload that meaningfully offsets cost.

The cost of this split is one additional env var (`VOYAGE_API_KEY`) and one extra secret to rotate. For a project that will exist for years, this is rounding error against the credit savings.

**Why not MongoDB Atlas Embedding API:** Voyage 4 is also accessible through MongoDB Atlas, but the vector store here is Qdrant, not Atlas. Adding Atlas purely as an embedding gateway means an extra vendor with no architectural benefit. Direct Voyage API is one less vendor relationship.

**`input_type` parameter (don't skip this):** pass `input_type="document"` in the backfill and sync embed calls; pass `input_type="query"` in `searchCatalog`. Voyage adds task-specific prompting on the backend. Omitting this leaves real recall on the table on retrieval workloads.

**Pre-flight assumed; revisit if recall is bad in practice.**

The live-data sampling (2026-05-12) showed `item_desc` is dominated by abbreviations a rep speaks natively but a small model may not encode consistently with a large one — `F/W`, `SOC CAP`, `SST`, `HELI-COIL INS`, `DIN125A`, etc. This is the regime where the "shared embedding space" claim across voyage-4-large/lite is most likely to crack.

Originally this plan called for a mandatory 3-way smoke test before backfill — we've decided to ship the asymmetric config and validate empirically instead, because the cost of being wrong is low: the entire backfill is ~3M tokens / well under 10 minutes of script time and free on Voyage's tier, so if recall is bad in practice we can re-backfill on a different model config without ceremony.

If you ever do want the smoke test (e.g. before scaling to vendor-spec-sheet ingestion in Phase 2 where re-backfilling is more expensive): run the same 10 hand-picked abbreviation-gap queries through three configs — large-doc/large-query, lite-doc/lite-query, large-doc/lite-query — on a 1000-row subset and compare top-3 recall.

### What we embed: a tight assembly of catalog text

**Decision:** the embed input for each `inv_mast` row is a short text assembly. Two real examples from Olander's actual catalog (verified 2026-05-12 against play env, see `P21_Samples.md`):

```
SKU: 6C100SFIS
Description: 6-32 X 1 SLOT FILL SST RoHS
Details: 6-32 X 1 Slot Fillister Head Stainless Steel RoHS
UOM: EA
```

```
SKU: .032SW
Description: .032 DIASAFETY WIRE 302 SST
UOM: EA
```

The second example is far more common than the first. Three things the real data forces on us:

1. **`extended_desc` is sparse and mixed quality.** Live numbers: 40% of rows have it populated; of those, ~25% is junk (`"RoHS"`, `"Non-RoHS"`, bare tolerance numbers like `".0939-.0941"`), ~75% is the *spelled-out* form of the abbreviated `item_desc` (`"SLOT FILL SST"` → `"Slot Fillister Head Stainless Steel"`). The spelled-out form is *exactly* what semantic search needs — it anchors what the cryptic abbreviation means. So the embed-input builder must include `extended_desc` when meaningful and **skip** it when it's empty, "RoHS"/"Non-RoHS", or a pure numeric tolerance.

2. **Descriptions are heavily abbreviated industrial jargon.** Average `item_desc` length is ~30 chars: `"M1.7 F/W DIN125A (1.8-4.5-0.3) STL BLK"`, `"HELI-COIL INS DFL"`, `"SOC SHOULDER SCREW SST"`. Reps speak these abbreviations natively, but a rep asking "stainless steel flat washer M1.7" needs the embedding model to know `F/W = flat washer` and `STL = steel`. This is the **most load-bearing reason** the asymmetric voyage-4-large/lite verification (next section) has to actually be run — if lite's encoding of these abbreviations drifts from large's, recall silently collapses on the most common query shape.

3. **Every other potentially-richer field is empty.** Live check across 80 varied rows: `keywords`, `brand_name`, `manufacturer_name`, `part_number`, `class_code`, `commodity_code`, `unspsc_code`, `generic_item_desc`, `item_notes` were **all 100% null**. There's nothing else to embed even if we wanted to.

**Why not richer:** moot — the richer fields don't exist in Olander's data. If they ever get populated (e.g. Olander backfills `keywords`), revisit. Until then, item_desc + filtered extended_desc + UOM is the whole signal.

**Why include UOM at all:** ~95% of rows are `"EA"` so it rarely disambiguates, but the remaining 5% (`BG`, `BX`, `BD`, etc.) is genuinely useful when present — "sold by the bag of 100" matters for the rep. Costs ~3 tokens to keep.

**SKU is included intentionally** so an exact SKU paste still hits its own row at the top of cosine similarity. (You'd usually route exact SKU through `entityGet`, but the model occasionally guesses wrong — having semantic search not embarrass itself on a SKU is a guardrail.)

### Hybrid retrieval, not pure vector

**Decision:** `searchCatalog` returns top-K candidates with `{ item_id, item_desc, extended_desc, score }`. The model then **chains** into `viewsQuery` / `entityGet` for the actual answer (stock, price, location).

**Why:**
- Vectors are great for "which 5 items match this description?" Bad for "what's the on-hand qty?" — that's a fact lookup against live data, not similarity.
- We don't want to materialize on-hand into the vector index because it changes constantly. Embedding stale stock counts is worse than not having them.
- Keeps the index lean (no high-churn columns) and the data fresh (live calls for the dynamic stuff).

The system prompt teaches the chain explicitly: "after `searchCatalog` returns candidates, query `p21_view_inv_loc` filtered on the resolved `item_id`s for stock." See [§ System prompt updates](#system-prompt-updates).

### Why not graph RAG

Quick note since this came up in design discussion:

P21 is already a graph — `customer → orders → order_lines → parts → vendors` are all FK relationships in a clean relational schema. Building a parallel graph index would mean:

1. **Two sources of truth.** The P21 graph drifts from our derived graph the moment any data changes.
2. **Maintenance overhead** for a structure that's already queryable via OData JOINs and chained `viewsQuery` calls.
3. **Negligible query-time benefit** for the kinds of questions reps actually ask (mostly 1-2 hops, well-known traversal paths).

The "graph reasoning" we need is encoded in the system prompt + tool design — the model knows to dereference FK IDs because we tell it to. That's good enough for everything in `VISION.md`'s five anchor use cases.

Graph RAG starts earning its complexity when **unstructured documents** enter the picture: a PDF spec sheet describing part X, made by vendor Y, for application Z, needs an explicit graph because there's no relational schema to traverse. We'll revisit then. Not now.

## Cost analysis

Numbers worth grounding the decision in. Voyage 4 list pricing: voyage-4-large $0.12/MTok, voyage-4 $0.06/MTok, voyage-4-lite $0.02/MTok. The first **200 million tokens are free per account** across the entire Voyage 4 family.

### Initial backfill

- Olander's `p21_view_inv_mast` is **~99,000 rows** (verified 2026-05-12 against play env by skip-bisecting between 99,000 and 99,500). This is at the low end of the original 50K-200K guess.
- Embed input averages **~30 tokens** per row, not the originally-assumed ~120. Live `item_desc` averages 30 chars (~7-8 tokens), `extended_desc` is empty 60% of the time and short when present, SKU + UOM + labels add ~15-20 tokens of framing.
- 99K rows × ~30 tokens = **~3M tokens**. At voyage-4-large's $0.12/MTok list price that's $0.36, but the 200M free tier swallows it whole. **Effective cost: $0.**

The originally-estimated 24M token backfill was ~8x too high. Both numbers comfortably fit inside Voyage's 200M free tier; the takeaway isn't "we saved money" (we didn't — both are free) but that the backfill will finish much faster than estimated. Embedding pricing is two orders of magnitude below chat completion pricing, and on Voyage's free tier this entire project costs nothing for the foreseeable future.

### Ongoing

- Daily incremental: only embeds rows whose content hash changed, on voyage-4-large. Catalog churn is low (maybe 50-200 changes/day at a fastener distributor), so we're talking ~25K tokens/day. Pennies per month if we ever leave the free tier.
- Query-side embeddings: each `searchCatalog` call embeds the user's query (~10-30 tokens) on voyage-4-lite. At 1000 chats/day with one search each, that's <1M tokens/month → **<$0.02/month** (and still inside the free tier).
- Combined free-tier budget: documents + queries together stay under 200M tokens/account for the first several years of normal operation. We re-evaluate cost when we approach the cap, not before.

### Cost guardrails (in code, not just policy)

The backfill script has a hard cap. Real catalog is ~3M tokens, so any of these triggering means something is wrong (runaway loop, duplicate embeds, etc.), not normal operation:

```ts
// Real catalog is ~3M tokens. 50M is 15x headroom — at voyage-4-large's
// $0.12/MTok that would be $6 if we ever left the free tier. Cap is a
// runaway-loop circuit breaker, not a cost ceiling.
const MAX_BACKFILL_TOKENS = 50_000_000;
const MAX_BACKFILL_DURATION_MS = 30 * 60_000; // 30 min ceiling
```

If either is exceeded, the script logs a warning and exits cleanly. We can rerun and pick up where it left off (content hashes mean already-embedded rows are skipped on the next run).

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Build / scheduled workers                                           │
│                                                                      │
│   scripts/backfill-catalog.ts ──┐                                   │
│                                  ├──▶  P21 (via droplet proxy)      │
│   scripts/sync-catalog.ts (cron)─┘     paginated views.query        │
│                                                                      │
│           │                                                          │
│           │  rows (PAGE=200), embeds chunked (EMBED_BATCH=100)      │
│           ▼                                                          │
│   embedDocuments(texts) ──HTTPS──▶ api.voyageai.com ──▶ voyage-4-large│
│           │                                                          │
│           │  Float[] vectors (1024d, shared embedding space)          │
│           ▼                                                          │
│   ┌────────── Qdrant upsert (point: id, vector, payload) ─────────┐│
│   │ id=inv_mast_uid (uint), vector=vec,                            ││
│   │ payload={item_id, item_desc, extended_desc?, sales_pricing_    ││
│   │          unit?, delete_flag}                                   ││
│   └────────────────────────────────────────────────────────────────┘│
│           │                                                          │
│           ▼                                                          │
│   onConflictDoUpdate into Neon.catalog_item (no embedding col)      │
│           - skip if embed_input_hash matches                         │
│           - else refresh text fields + hash + embeddedAt             │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  Request path (chat)                                                 │
│                                                                      │
│   user: "stainless M10 cap screw, ~50mm"                            │
│       │                                                              │
│       ▼                                                              │
│   model picks searchCatalog (per system prompt)                     │
│       │                                                              │
│       ▼                                                              │
│   searchCatalog.execute({ query, topK: 5 })                         │
│       │                                                              │
│       ├──▶ embedQuery(query) → api.voyageai.com → voyage-4-lite (~80ms)│
│       │                                                              │
│       ▼                                                              │
│   qdrant.search('olander-catalog', {                                │
│     vector, limit: topK, with_payload: true,                        │
│     filter: { must: [{ key: 'delete_flag',                          │
│                        match: { value: false } }] }                 │
│   })                                                                │
│     returns matches[] with score + payload          (~5-15ms)       │
│       │                                                              │
│       ▼                                                              │
│   model receives candidates, optionally chains:                     │
│     viewsQuery(p21_view_inv_loc, filter="item_id eq 'X' or ...")    │
│     for live stock                                      (~600ms)    │
└─────────────────────────────────────────────────────────────────────┘
```

**Write order is load-bearing:** Qdrant first, then Neon. If Qdrant fails, Neon's hash stays stale and the next sync retries the batch. Reversing the order would create rows that claim "embedded" while Qdrant has no vector — silently missing from search until the row's text changes.

## Schema

```sql
-- delete_flag is boolean (NOT char(1) / 'Y'/'N') because the droplet proxy
-- normalizes P21's "Y"/"N" string into a JSON boolean before we ever see it.
-- Storing it as a string here would mean the catalog never matches the proxy
-- output during sync. Verified live 2026-05-12: GET ...p21_view_inv_mast with
-- $select=delete_flag returns `"delete_flag": false`, not `"N"`.
CREATE TABLE "catalog_item" (
  "inv_mast_uid"        integer        PRIMARY KEY,
  "item_id"             text           NOT NULL UNIQUE,
  "item_desc"           text,
  "extended_desc"       text,
  "sales_pricing_unit"  text,
  "delete_flag"         boolean        NOT NULL DEFAULT false,
  "source_modified_at"  timestamptz,                  -- from P21 row
  "embed_input_hash"    text           NOT NULL,      -- sha256 of embed input
  "embedded_at"         timestamptz    NOT NULL DEFAULT now()
);

-- No embedding column — Qdrant is the vector store. The pgvector extension
-- stays enabled on Neon (no-op cost) so future smaller indexes can use it
-- without another migration round.
-- No separate btree on item_id: the UNIQUE constraint above creates one.
```

Drizzle schema in `src/db/schema.ts`:

```ts
import { pgTable, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";

export const catalogItem = pgTable("catalog_item", {
  invMastUid: integer("inv_mast_uid").primaryKey(),
  itemId: text("item_id").notNull().unique(),
  itemDesc: text("item_desc"),
  extendedDesc: text("extended_desc"),
  salesPricingUnit: text("sales_pricing_unit"),
  deleteFlag: boolean("delete_flag").notNull().default(false),
  sourceModifiedAt: timestamp("source_modified_at", { withTimezone: true, mode: "date" }),
  embedInputHash: text("embed_input_hash").notNull(),
  embeddedAt: timestamp("embedded_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
```

The Qdrant collection alongside this lives in `src/lib/ai/qdrant.ts`:

```ts
export const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION ?? "olander-catalog";
export const QDRANT_DIM = 1024;
export const QDRANT_DISTANCE = "Cosine" as const;
export type CatalogVectorPayload = {
  item_id: string;
  item_desc: string;
  extended_desc?: string;
  sales_pricing_unit?: string;
  delete_flag: boolean;
};
```

Why these columns specifically:
- `inv_mast_uid` PK because P21 may eventually issue duplicate `item_id`s across companies/divisions; UID is the stable key.
- `item_id` UNIQUE because we lookup by it constantly and humans recognize it. Edge case to watch: if P21 ever reassigns an `item_id` from one `inv_mast_uid` to another, the sync upsert (which conflicts on `inv_mast_uid`) errors on the *secondary* `item_id` unique violation. Rare, but the sync script should catch it and either soft-delete the previous holder or fall back to `onConflictDoNothing` with a logged warning.
- We mirror the descriptive fields rather than re-querying P21 on every search hit. The trade-off is a copy that can drift; the upside is that `searchCatalog` returns useful information without a second round-trip. Sync keeps it within a day of P21.
- `embed_input_hash` lets us skip re-embedding rows whose content didn't actually change. Hash = sha256 of the assembled embed input string. Matching hashes ⇒ Qdrant already has the right vector ⇒ no Voyage call, no Qdrant upsert. Different hashes ⇒ re-embed and overwrite by ID in Qdrant (atomic per point).
- `delete_flag` mirrored both here and in Qdrant payload. Neon's column is the audit source of truth; Qdrant's payload is what the query-time filter (`{ must: [{ key: 'delete_flag', match: { value: false } }] }`) reads. Both must update together on a soft-delete event — see `scripts/sync-catalog.ts` for the dual write.

## Backfill script

`scripts/backfill-catalog.ts`. Run via `npx tsx scripts/backfill-catalog.ts`.

Pseudocode shape:

```ts
// Page size for upstream P21 views. The chatbot tool caps $top at 50 (LLM
// context concerns), but the proxy itself has no Zod cap — the backfill calls
// callProxy() directly, not the tool wrapper. Verify the proxy's own ceiling
// at backfill time (P21 has historically returned up to 1000 cleanly; pick a
// value that comes back in <5s per page to avoid the 25s proxy timeout).
const PAGE = 200;
const EMBED_BATCH = 100;          // Voyage accepts up to 1000; 100 keeps memory bounded
// Caps declared in the Cost guardrails section above:
//   MAX_BACKFILL_TOKENS, MAX_BACKFILL_DURATION_MS.

let skip = 0;
let totalTokens = 0;
const start = Date.now();

while (true) {
  if (Date.now() - start > MAX_BACKFILL_DURATION_MS) bail("time cap");
  if (totalTokens > MAX_BACKFILL_TOKENS) bail("token cap");

  // Direct proxy call — not via the `viewsQuery` tool, which caps top at 50.
  const { rows } = await callProxy("POST", "/proxy/views/p21_view_inv_mast", {
    select: ["inv_mast_uid", "item_id", "item_desc", "extended_desc",
             "sales_pricing_unit", "delete_flag", "date_last_modified"],
    orderBy: "inv_mast_uid",
    top: PAGE,
    skip,
  });

  if (rows.length === 0) break;

  // Build embed inputs + hashes; dedupe against existing rows by hash
  const candidates = rows.map(buildEmbedCandidate);
  const existing = await db.select({ uid: catalogItem.invMastUid, hash: catalogItem.embedInputHash })
    .from(catalogItem)
    .where(inArray(catalogItem.invMastUid, candidates.map(c => c.invMastUid)));

  const toEmbed = candidates.filter(c => existing.find(e => e.uid === c.invMastUid)?.hash !== c.hash);

  // Embed in sub-batches (voyage-4-large, input_type="document", output_dimension=1024)
  for (const batch of chunk(toEmbed, EMBED_BATCH)) {
    const { vectors, totalTokens: batchTokens } = await embedDocuments(batch.map(b => b.text));
    totalTokens += batchTokens; // Voyage's reported usage — exact, not estimated.
    await db.insert(catalogItem).values(batch.map((b, i) => ({ ...b.row, embedding: vectors[i], embedInputHash: b.hash })))
      .onConflictDoUpdate({
        target: catalogItem.invMastUid,
        // Update every field that can change in P21. Skip `invMastUid` (the
        // conflict target) and `embeddedAt` defaults to now() — let it.
        // Critical: update `embedding` and `embedInputHash` in lock-step, or
        // the table will end up with stale text paired to a fresh vector.
        set: {
          itemId:           sql`excluded.item_id`,
          itemDesc:         sql`excluded.item_desc`,
          extendedDesc:     sql`excluded.extended_desc`,
          salesPricingUnit: sql`excluded.sales_pricing_unit`,
          deleteFlag:       sql`excluded.delete_flag`,
          sourceModifiedAt: sql`excluded.source_modified_at`,
          embedInputHash:   sql`excluded.embed_input_hash`,
          embedding:        sql`excluded.embedding`,
          embeddedAt:       sql`now()`,
        },
      });
  }

  skip += rows.length;
  // Cost log uses voyage-4-large's $0.12/MTok — the model this backfill calls.
  // (Inside the 200M free-token tier this is hypothetical; it's a sanity gauge.)
  log(`processed ${skip}, embedded ${toEmbed.length} this page, ~$${(totalTokens * 0.12 / 1_000_000).toFixed(4)} hypothetical so far`);
}
```

Notes:
- Single-process, sequential pages. The proxy is the bottleneck (P21 is slow), so parallelizing pages doesn't help much and risks rate-limiting.
- Idempotent by `embed_input_hash`. Re-running after a partial failure picks up where it stopped.
- Logs running cost estimate so you can pull the cord if it's growing faster than expected.
- `bail()` exits 1 with a structured log — we want CI/cron to notice if a cap is hit.

### The "modified-at" column (resolved)

Verified 2026-05-12: `p21_view_inv_mast` has `date_last_modified`, populated on every row (100%, 50/50 in our sample). This was an open question in earlier drafts; it's resolved. The original concern that it might be named `date_modified` or `last_maint_date` or be absent entirely is now moot for `inv_mast` — but the column name *does* vary across views (some have `date_modified`, some `date_last_maintained`), so re-verify before reusing this pattern for `customer`, `vendor`, etc.

## Incremental sync

`scripts/sync-catalog.ts`, run via Vercel cron (or GitHub Action — Vercel cron is simpler; verify availability on our plan).

Logic:
1. Read `MAX(source_modified_at)` from `catalog_item`.
2. `viewsQuery` `p21_view_inv_mast` filtered to rows with `date_last_modified ge <max>`. Use `ge` not `gt`: `date_last_modified` is second-resolution, multiple rows can share the same value as the current max, and `gt` would silently skip them on the next run. Re-fetching the boundary rows is free because `embed_input_hash` skips re-embedding unchanged content.
3. Run the same embed + upsert path as the backfill script.
4. Soft-delete two ways:
   - Rows where the proxy reports `delete_flag: true` (P21 raw `'Y'`, normalized by the proxy) → mark deleted in our table (don't actually `DELETE` — keep audit trail).
   - Rows that vanish from `p21_view_inv_mast` entirely (no `delete_flag`, just no longer returned) → caught by a periodic full UID scan. Once a week is fine; pull every `inv_mast_uid` from the proxy, diff against `catalog_item.inv_mast_uid`, mark the missing ones deleted. Done as part of the same cron via a weekday check (e.g. only on Sundays), not a second cron.

**Cadence:** daily at ~02:00–03:00 America/Los_Angeles (off-hours for Olander reps; pre-dawn so a fresh index is ready by 7am). Vercel cron expressions run in UTC, so this is `0 10 * * *` (10:00 UTC = 02:00 PST in winter / 03:00 PDT in summer — accept the daylight-savings hour drift, it doesn't matter for a catalog sync). On Hobby plan, scheduling precision is ±59 min — actual fire time is between 10:00–10:59 UTC. Catalog doesn't change minute-to-minute and the sync isn't user-blocking, so the imprecision is fine.

## Tool design

`src/lib/ai/tools.ts` gets a third tool:

```ts
const searchCatalog = tool({
  description:
    "Semantic search over Olander's parts catalog. Use this when the rep " +
    "describes a part in their own words (e.g. 'M10 stainless cap screw, " +
    "around 50mm') rather than giving an exact SKU. Returns top-K candidates " +
    "by similarity. Follow up with viewsQuery against p21_view_inv_loc on the " +
    "returned item_ids for live stock, or entityGet for the full record. " +
    "Do NOT use this for exact-SKU lookups — use entityGet({area:'inventory', " +
    "resource:'v2/parts', id:<sku>}) for those (faster, authoritative).",
  inputSchema: z.object({
    query: z.string().min(2).max(256).describe(
      "Natural-language description of the part. The rep's own phrasing is fine — " +
      "no need to translate to formal terms.",
    ),
    topK: z.number().int().min(1).max(20).default(5),
  }),
  execute: async ({ query, topK }) => {
    const vec = await embedQuery(query); // voyage-4-lite, input_type="query"
    // Qdrant returns matches in descending cosine score; the `filter`
    // (with a payload index on delete_flag) drops soft-deleted SKUs
    // server-side rather than post-filtering and losing top-K.
    const matches = await searchCatalogByVector(vec, topK);
    return {
      matches: matches.map((m) => ({
        item_id: m.payload?.item_id,
        item_desc: m.payload?.item_desc,
        extended_desc: m.payload?.extended_desc,
        sales_pricing_unit: m.payload?.sales_pricing_unit,
        score: m.score,
      })),
    };
  },
});
```

Embedding wrapper lives in `src/lib/ai/embeddings.ts`. Exposes two thin functions, both hitting `api.voyageai.com/v1/embeddings` directly with `VOYAGE_API_KEY`:
- `embedDocuments(texts: string[]): Promise<{ vectors: number[][]; totalTokens: number }>` — calls voyage-4-large with `input_type="document"`, `output_dimension=1024`. Used by backfill and sync. Returns Voyage's reported `usage.total_tokens` so the backfill cap is exact, not estimated.
- `embedQuery(text: string): Promise<number[]>` — calls voyage-4-lite with `input_type="query"`, `output_dimension=1024`. Used by `searchCatalog`.

Pin `output_dimension=1024` explicitly on every call. Voyage 4 supports Matryoshka dimensions (256/512/1024/2048); relying on the per-model default risks a silent vendor change writing the wrong-shaped vector into a `vector(1024)` column, which fails loudly on insert (good) but only on the first row that hits the changed default (annoying mid-backfill).

Both batch inputs, retry once on transient errors, and throw on hard failure (the tool wrapper catches and returns the standard `{ error: "tool_failed", detail }` shape). Returning two named functions instead of one parameterized `embedAll` makes it impossible to accidentally embed documents through the lite path or queries through the large path, which would silently degrade recall without erroring.

## System prompt updates

`src/lib/ai/system-prompt.ts` gets a new section after the existing tool descriptions:

```
## 3. searchCatalog — semantic search over the parts catalog

Use this for ANY part question phrased descriptively. Example queries:

  searchCatalog({ query: "M10 1.25 stainless cap screw 50mm", topK: 5 })
  searchCatalog({ query: "anti-seize compound for high-temp fasteners" })
  searchCatalog({ query: "phillips head wood screw, 1.5 inch" })

Do NOT use searchCatalog when the rep gives an exact SKU — use entityGet
or viewsQuery for those (faster, authoritative).

Common chain: searchCatalog returns candidates → pick the best 1-3 →
viewsQuery p21_view_inv_loc with `item_id eq 'X' or item_id eq 'Y' or ...`
to get live on-hand. Present the table with item_id, description, on-hand,
and the location.
```

The "Tool-call efficiency" section already encourages parallel calls; no changes needed there. The "How to answer" section gets one bullet:

```
- For descriptive part questions ("we need a stainless cap screw, M10,
  about 50mm"), START with searchCatalog. Don't try to write OData
  substringof filters against item_desc — semantic search will recall
  variants that string matching misses.
```

## Testing & rollout

### Pre-merge

- Unit tests in `src/lib/ai/__tests__/`:
  - Embed input assembly is stable for a given row (same input → same hash).
  - The `searchCatalog` tool's Zod schema rejects bad input.
  - The vector literal serializer handles the dim-1024 array correctly.
- Manual smoke: backfill a 1000-row subset, run 10 hand-picked descriptive queries against `searchCatalog`, validate the top result is the obvious match (or convince yourself why not).

### Regression watch (per `TESTING.md` discipline)

If this lands, add a `Retrieval` section to `TESTING.md` with:
- Backfill script runs to completion against a small subset without errors.
- A canonical descriptive query returns the expected SKU in top-3.
- The chat tool surfaces matches in <500ms total (embed + query) on a warm pool.
- Sync script handles the "no rows changed" case cleanly (no partial writes, no spurious updates).

## Future phases

Tracked here so we don't lose the thread.

### Phase 2 — unstructured documents

This will be a functionality that needs to live in the admin panel not something any user has access to

When vendor spec sheets, MSDSs, or customer correspondence enter the system:
- Same vector store. New table `document_chunk` with `(document_id, chunk_idx, text, embedding, source_uri)`.
- Chunking pipeline (probably semantic chunking, not fixed-size) lives alongside `scripts/backfill-catalog.ts`.
- New tool `searchDocuments(query, topK)` — same shape as `searchCatalog`.
- *This* is where graph relationships start mattering — when an unstructured chunk references a part, we want the link. Likely solution: extract entity mentions during chunking, store as a `chunk_mention(chunk_id, entity_type, entity_id)` join table. Lightweight graph-without-a-graph-DB.

### Phase 3 — re-ranking

Once we have real query traffic:
- Capture (query, returned candidates, which one the rep actually wanted) tuples.
- Add a Voyage cross-encoder re-ranker between vector search and tool result.
- Measure recall@1 before vs. after.

### Phase 4 — embedding orders / pricing trends

Speculative. If we want "find customers with similar purchase patterns to ACME" or "items that often co-purchase," that's an embedding job over aggregated order-line data. Entirely different shape from catalog search; defer until there's a use case with a stakeholder behind it.

## Summary

| Decision | Choice | Why in one line |
|---|---|---|
| Vector store | Qdrant Cloud (us-west-1) | Free 4 GB tier sits next to sfo1 functions; isolates catalog growth from Neon's user-shaped tables |
| Embedding model | voyage-4-large (docs) + voyage-4-lite (queries), 1024d | Shared embedding space lets us pay for quality once on the compounding path and stay cheap on the hot path; both fit inside Voyage's 200M free tier |
| Access | Direct Voyage API for embeddings; Vercel AI Gateway for Claude chat only | Keeps Voyage's 200M free token pool separate from Vercel's promotional credits, which are better spent on chat completions (50-150x more expensive per token) |
| What to embed | Inv master only, Phase 1 | Catalog is where fuzzy match wins; orders/customers don't need it |
| Tool design | New `searchCatalog`, additive | Doesn't replace `viewsQuery`/`entityGet`; chains with them |
| Architecture | Hybrid retrieval | Vectors find candidates, OData fetches live data |
| Index population | Backfill script + daily sync | Idempotent by content hash; cost-capped |
| Graph RAG | No | P21 is already a graph; revisit when unstructured docs land |
