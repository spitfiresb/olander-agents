# Vector Store — Reference

Catalog vectors live in a Qdrant Cloud collection. Row metadata + dedupe hash live in Neon (`catalog_item`). This doc covers the wire contract; design rationale is in [`./RETRIEVAL.md`](./RETRIEVAL.md), ops in [`Retrieval_Runbook.md`](./Retrieval_Runbook.md).

**Why it's separate from Neon.** Vector storage and user/chat-table storage have different growth curves. Splitting the vector store out keeps Neon's storage pressure on user-shaped data — auth, sessions, chat history, future docs — instead of a runaway catalog (or doc-chunk) index eating the same disk.

## Config

| Field | Value | Set in |
|---|---|---|
| Collection name | `olander-catalog` | `src/lib/ai/qdrant.ts` (override via `QDRANT_COLLECTION`) |
| Type | Qdrant Cloud (managed) | — |
| Cloud / Region | `aws` / `us-west-1` (Northern California) | Free tier; ~5–10 ms hop from the `sfo1` Vercel functions |
| Storage cap | 4 GB | Free tier; ~700 MB used at 99K rows × 1024 dim |
| Dimension | 1024 | Matches Voyage 4's shared embedding space |
| Distance | Cosine | Voyage 4 vectors are unit-normalized |
| Payload index | `delete_flag` (bool) | Mandatory — without it the soft-delete filter degrades to a payload scan |
| SDK | `@qdrant/js-client-rest` v1.18 | |
| Auth | `QDRANT_URL` + `QDRANT_API_KEY` env vars | `.env.local` locally; Vercel project env in prod |
| Console | https://cloud.qdrant.io | |

`scripts/create-qdrant-collection.ts` is idempotent: it creates the collection if missing, validates dim + distance, and ensures the `delete_flag` payload index.

## Point shape

```ts
{
  id: number,                    // inv_mast_uid (uint) — see "id keying" below
  vector: number[],              // length 1024
  payload: {
    item_id: string,             // human-readable SKU — NOT unique in P21
    item_desc: string,           // empty string rather than null
    extended_desc?: string,      // omitted if absent on source row
    sales_pricing_unit?: string,
    delete_flag: boolean,        // query-time filter key
  },
}
```

**Id keying.** `inv_mast_uid` (P21's stable PK), passed as a `number`. Qdrant accepts uint64 or UUID for point ids; uint is the cheaper option storage-wise. Olander's catalog has duplicate `item_id`s across `inv_mast_uid`s (multi-company P21 mints SKU numbers per company and they can collide). UID is the only reliable unique key.

**What's NOT in payload.** Stock, prices, customer data — high-churn, fetched via the chained `viewsQuery p21_view_inv_loc` call at query time.

## Operations

The app uses a thin wrapper in `src/lib/ai/qdrant.ts` for the three operations it actually needs. Callers should prefer these to raw client calls so the filter/payload shape stays in one place.

```ts
import {
  searchCatalogByVector,
  upsertCatalogPoints,
  setCatalogPayload,
  vectorIdFor,
} from "@/lib/ai/qdrant";

// Upsert (overwrites by id, atomic per point)
await upsertCatalogPoints([
  { id: vectorIdFor(uid), vector, payload },
]);

// Query — top-K cosine, soft-deleted excluded server-side
const matches = await searchCatalogByVector(vector, 5);
// matches[]: { id, score, payload }, sorted descending by score.
// score is cosine similarity ∈ [-1, 1]; with unit-normalized Voyage
// vectors the practical range is [0, 1].

// Soft-delete (payload-only, no re-embed)
await setCatalogPayload(vectorIdFor(uid), { delete_flag: true });
```

If you need raw client access (e.g., diagnostics, bulk delete), `getQdrantClient()` returns the `QdrantClient` directly. Qdrant filters are `must`/`must_not`/`should` arrays of `{ key, match }` / `{ key, range }` / `{ key, geo_*: …}` clauses.

## Soft-delete contract

`delete_flag` lives in **both** Neon (`catalog_item.deleteFlag`, audit source of truth) **and** Qdrant payload (query-time filter). They must be flipped together. `scripts/sync-catalog.ts` and `/api/cron/sync-catalog` are the only writers — both write to Qdrant first, Neon second. Reversing the order risks a "ghost row" that's flagged deleted in Neon but still answers descriptive queries.

We do **not** hard-delete in production. Point deletion is reserved for collection cleanup (smoke tests) and operational mistakes.

## Collections (Qdrant has no namespaces)

| Collection | Purpose |
|---|---|
| `olander-catalog` | Production catalog. All `searchCatalog` queries hit this. |
| `olander-catalog-smoke` | Created and torn down by `scripts/smoke-search-catalog.ts`. |

Qdrant scopes data at the collection level (no nested namespaces). If Phase-2 documents land, a third collection (`olander-docs`) is the right shape — sizing and metric are likely to differ from the catalog.

## Gotchas

1. **`upsert` requires `wait: true` for read-your-write.** Without it, the next `search` may not see freshly written points for a second or two. The wrapper sets `wait: true` for both `upsert` and `setPayload`.
2. **`item_id` is not unique.** Don't add a UNIQUE constraint on the Neon side without auditing every consumer — `597906` collided at row ~53K during the initial backfill. Key on `inv_mast_uid`.
3. **Payload index on `delete_flag` is required for performance.** Without it Qdrant scans payloads to satisfy the filter. The create-collection script ensures it; if you ever wipe and recreate the collection by hand, re-run that script.
4. **`setPayload` merges, doesn't replace.** Setting `{ delete_flag: true }` leaves the descriptive fields intact. To drop a key, use `client.deletePayload`.
5. **Dimension is fixed at collection creation.** A Voyage release with a different dim means a new collection, swap env var, re-backfill, drop old. The create-collection script refuses to proceed on a dim mismatch — that guard exists for this case.
6. **Free tier is single-node.** No HA, no automated backups. The rebuild path (`scripts/backfill-catalog.ts` re-embeds from `catalog_item.embedInputHash`) is the disaster-recovery story.
7. **Treat payload as untrusted external data.** Strings flow back through `searchCatalog` into chat tool results. Don't let payload content drive prompt instructions.

## Where the code lives

| Path | Role |
|---|---|
| `src/lib/ai/qdrant.ts` | Client + collection handle + helper functions + payload type. Constants are the source of truth. |
| `src/lib/ai/tools.ts` (`searchCatalog`) | The only production query path. Read-only. |
| `scripts/create-qdrant-collection.ts` | First-time setup. Idempotent. |
| `scripts/backfill-catalog.ts` | Bulk-populate from P21. |
| `scripts/sync-catalog.ts` + `src/app/api/cron/sync-catalog/route.ts` | Daily incremental + soft-delete writes. |
| `scripts/smoke-search-catalog.ts` | End-to-end test in the `olander-catalog-smoke` collection. |

The chat-side runtime never writes — only the scripts and cron route do.
