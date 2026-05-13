# Retrieval — Operational Runbook

How to run, monitor, and recover the catalog-vector index. Pairs with [`../RETRIEVAL.md`](../RETRIEVAL.md), which is the design doc; this is the operations doc.

## Components at a glance

| Component | Where | Purpose |
|---|---|---|
| `catalog_item` table | Neon (Vercel project) | One row per `inv_mast_uid` carrying the descriptive fields + dedupe hash. **No `embedding` column** — vectors live in Qdrant. |
| `olander-catalog` collection | Qdrant Cloud (1024d cosine, AWS us-west-1) | The actual vector index, keyed on `inv_mast_uid` (uint). Payload: `item_id`, `item_desc`, `extended_desc?`, `sales_pricing_unit?`, `delete_flag`. |
| `src/lib/ai/qdrant.ts` | Vercel runtime + CLI | Cached Qdrant client + helper functions (`searchCatalogByVector`, `upsertCatalogPoints`, `setCatalogPayload`). Single source of truth for collection name / dims / metric. |
| `src/lib/ai/embeddings.ts` | Vercel runtime | Voyage wrapper. `embedDocuments` (voyage-4-large), `embedQuery` (voyage-4-lite). |
| `src/lib/ai/tools.ts` → `searchCatalog` | Vercel runtime | The chatbot tool the model calls. Embeds via voyage-4-lite, queries Qdrant with the `delete_flag` filter, returns matches with payload. |
| `scripts/create-qdrant-collection.ts` | Local CLI | Idempotent collection creator + payload-index installer. Run once at setup. |
| `scripts/backfill-catalog.ts` | Local CLI | Initial population from `p21_view_inv_mast` → Qdrant + Neon. |
| `scripts/sync-catalog.ts` | Local CLI | Same as the cron, runnable locally. |
| `/api/cron/sync-catalog` | Vercel runtime | Daily HTTP-triggered incremental sync. |
| `vercel.json` `crons[]` | Vercel | Schedules the daily 10:00 UTC fire. |

## Required environment

`.env.local` (for scripts) and Vercel project env (for the cron route):

| Variable | What it's for | Where to get it |
|---|---|---|
| `DATABASE_URL` | Neon Postgres connection | Vercel-Neon integration; `vercel env pull` |
| `VOYAGE_API_KEY` | Voyage embeddings | Voyage dashboard → API Keys |
| `QDRANT_URL` | Qdrant Cloud cluster endpoint | https://cloud.qdrant.io → cluster detail page |
| `QDRANT_API_KEY` | Qdrant Cloud auth | Same page → Data Access Control |
| `QDRANT_COLLECTION` | Override the default collection name (`olander-catalog`) | Only set in staging / preview envs |
| `DROPLET_PROXY_URL` | Reading `p21_view_inv_mast` | Printed at the end of `scripts/droplet/install.sh` |
| `DROPLET_PROXY_TOKEN` | Same | Same |
| `CRON_SECRET` | Vercel cron auth | `openssl rand -base64 32`; set in Vercel project env only |

Without `VOYAGE_API_KEY` **or** Qdrant credentials the `searchCatalog` tool fails closed with `{ error: "search_not_configured" }`. Without `CRON_SECRET` the cron endpoint always returns 401.

## First-time setup

Once. Idempotent if re-run.

1. **Apply the Drizzle migrations.**

   ```bash
   npm run db:migrate
   ```

   Brings `catalog_item` to current shape (descriptive fields + hash, no embedding column). The `vector` extension stays enabled on Neon as a no-op cost in case a smaller future index wants it back.

2. **Create the Qdrant collection.** Idempotent — re-running just confirms config and ensures the payload index.

   ```bash
   npx tsx --env-file=.env.local scripts/create-qdrant-collection.ts
   ```

3. **Backfill the catalog.** Network requirement: the script POSTs to `${DROPLET_PROXY_URL}/proxy/views/p21_view_inv_mast`. If you're on a corporate network that does TLS interception (Fortinet, Zscaler, Palo Alto SSL Decrypt), the droplet's Let's Encrypt cert will fail to verify and the backfill will throw `unable to verify the first certificate`. Run it from a network without the inspecting middlebox, or — for a one-off — install the middlebox's CA into Node's trust store and re-run with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.

   ```bash
   # Smoke run — 1000 rows, asserts pagination + hashing without committing to a full run
   LIMIT=1000 npx tsx scripts/backfill-catalog.ts

   # Dry run — fetches and hashes every page but skips Voyage and DB writes
   DRY_RUN=1 npx tsx scripts/backfill-catalog.ts

   # Full run
   npx tsx scripts/backfill-catalog.ts
   ```

   The full run logs cost as it goes (`~$0.0000 hypothetical so far` — voyage-4-large list pricing × tokens, the actual cost on the free tier is $0). It bails if it crosses `MAX_BACKFILL_TOKENS` (50M) or the duration cap (defaults to 30 min, override with `MAX_DURATION_MIN=<n>`); both are circuit breakers, not budget caps. Real catalog is ~3M tokens.

   **Per-page delay (`PAGE_DELAY_MS`, default 2500 ms):** the droplet proxy enforces a 30 req/min per-IP bucket. Without a pacing delay the dedupe-only pages burst past the limit and you get HTTP 429 from the proxy. The default 2.5s caps us at ~24 RPM safely under the bucket. During embed-heavy phases Voyage dominates page time anyway.

4. **Verify the search path.**

   ```bash
   VOYAGE_QPS_DELAY_MS=22000 npx tsx --env-file=.env.local scripts/smoke-search-catalog.ts
   ```

   Embeds 20 synthetic-but-realistic rows, upserts them into an isolated `olander-catalog-smoke` Qdrant collection (so production vectors are untouched), runs 10 descriptive queries through `searchCatalog`'s path, asserts top-3 contains the expected SKU, then deletes the collection. Use the 22-second pacing only if Voyage is on the no-billing free tier (3 RPM); on paid tier leave `VOYAGE_QPS_DELAY_MS` unset.

5. **Wire the cron.** Already configured in `vercel.json`. Set `CRON_SECRET` in the Vercel project's env (Production + Preview both). Also confirm `QDRANT_URL` and `QDRANT_API_KEY` are set in Vercel — without them the cron endpoint 503s with `qdrant_not_configured`. Verify in the Vercel dashboard → Project → Settings → Cron Jobs that `/api/cron/sync-catalog` is listed and enabled.

## Daily operations

The Vercel cron fires `/api/cron/sync-catalog` at 10:00 UTC daily. On Hobby plan the precision is ±59 min, which is fine — the catalog doesn't change minute-to-minute and the sync isn't user-blocking. The endpoint returns JSON like:

```json
{ "ok": true, "embedded": 47, "skipped": 152, "softDeleted": 2, "tokens": 1432, "elapsedMs": 18234 }
```

Watch in Vercel → Project → Logs filtered to `/api/cron/sync-catalog`. The function is idempotent: rerunning it on the same minute produces nothing harmful — every row whose hash hasn't changed is skipped.

### Sunday weekly reconcile

The same endpoint, on Sundays in America/Los_Angeles, also runs the full UID reconcile: pulls every `inv_mast_uid` from the proxy, diffs against `catalog_item`, and soft-deletes rows that vanished from P21 without ever flipping `delete_flag`. To trigger it on demand from local (e.g. after a bulk P21 cleanup):

```bash
FORCE_FULL_RECONCILE=1 npx tsx scripts/sync-catalog.ts
```

## How a query flows

```
Chat → /api/chat → streamText
                      ↓ model picks `searchCatalog`
                searchCatalog.execute({ query, topK })
                      ↓
                embedQuery(query) → api.voyageai.com (voyage-4-lite, ~80ms)
                      ↓
                searchCatalogByVector(vector, topK)
                  → Qdrant `search` with filter
                    { must: [{ key: 'delete_flag', match: { value: false } }] }
                  → returns matches[] with score + payload        (~5-15ms)
                      ↓
                { matches: [{ item_id, item_desc, extended_desc,
                              sales_pricing_unit, score }] } → back to model
                      ↓ (model decides whether to chain)
                viewsQuery p21_view_inv_loc for live stock        (~600ms)
```

The query embedding is **always** voyage-4-lite, the document embedding is **always** voyage-4-large. They share a 1024-dim space. Mixing the two halves is fine because of the shared space; mixing **dimensions** would silently break — every call pins `output_dimension=1024` and the Qdrant collection is created `size: 1024` (validated at creation time by `scripts/create-qdrant-collection.ts`).

There is no Neon round-trip on the query path. The descriptive fields the tool returns come straight out of Qdrant payload. Neon's `catalog_item` is exercised only by the write paths (backfill, sync, dedupe lookups).

## Diagnostics

### "Why didn't the model pick searchCatalog?"

Look in the conversation persistence — `message.parts` records every tool invocation. If the model wrote a `viewsQuery` against `p21_view_inv_mast` with a `substringof('XXX', item_desc)` filter, the system prompt isn't steering it right. Re-read `src/lib/ai/system-prompt.ts` § 3 and the "How to answer" bullet.

### "searchCatalog returned no results"

```bash
node scripts/check-pgvector.mjs          # Neon side — row counts + indexes

# Qdrant side — collection stats via the SDK
node --env-file=.env.local --input-type=module -e "
  import { QdrantClient } from '@qdrant/js-client-rest';
  const c = new QdrantClient({ url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY });
  console.log(await c.getCollection('olander-catalog'));
"
```

Confirm both are populated. Discrepancies between Neon's `catalog_item` row count and Qdrant's `points_count` mean one of the two writes failed mid-sync — re-run sync (it's idempotent; rows whose hash matches Neon's are skipped, rows whose Qdrant-side is missing get re-pushed).

### "Top-K looks bad"

Spot-check via `scripts/smoke-search-catalog.ts` — it exercises the exact same Qdrant query path with controlled inputs in an isolated collection, so you can read the cosine scores without touching production.

For a raw ad-hoc query against the real production collection, use the helpers directly:

```ts
import { embedQuery } from "@/lib/ai/embeddings";
import { searchCatalogByVector } from "@/lib/ai/qdrant";

const vec = await embedQuery("M10 stainless cap screw");
const matches = await searchCatalogByVector(vec, 10);
console.dir(matches, { depth: 4 });
```

If a SKU that ought to match is returning a low score, inspect what it was actually embedded as:

```sql
SELECT item_id, item_desc, extended_desc, sales_pricing_unit, embed_input_hash, embedded_at
  FROM catalog_item
 WHERE item_id = 'PN12345-01';
```

The `embed_input_hash` corresponds to `buildEmbedInput()` output for the row's fields at the time of embed. If the row's `item_desc` has been edited in P21 but the catalog still has the old hash, the sync hasn't caught up yet — wait for the next cron, or run sync manually.

### "Voyage rate-limit / 429"

Free tier without a payment method is capped at **3 RPM / 10K TPM**. The first 200M tokens are still free with billing on file. If you're seeing 429s in production logs, add a payment method to the Voyage account (https://dashboard.voyageai.com/) — embeddings stay on the free tokens.

### "Embedding mismatch — vector shape doesn't fit"

The Qdrant collection is fixed-dim (1024) at creation. Every Voyage call pins `output_dimension=1024`. If the SDK throws on `upsert` complaining about vector size, something has changed the dim — most likely a vendor default flip that we no-op around by pinning explicitly. Re-check the request body in `src/lib/ai/embeddings.ts` for the `output_dimension` parameter.

### "Sync hangs on a particular page"

The proxy times out upstream calls at 25s. If a particular `skip=N` page hangs, query the proxy directly:

```bash
curl -sS -X POST "$DROPLET_PROXY_URL/proxy/views/p21_view_inv_mast" \
  -H "Authorization: Bearer $DROPLET_PROXY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"select":["inv_mast_uid","item_id"],"orderBy":"inv_mast_uid","top":200,"skip":12345}' | head
```

If the proxy returns `{ "error": "upstream_timeout" }`, P21 itself is slow — wait, then re-run. The backfill is idempotent; it'll skip everything already embedded.

## Rolling back

The whole feature is additive: removing the vectors leaves chat working (just without the search tool). To revert:

```sql
DROP TABLE IF EXISTS catalog_item;
-- Do NOT DROP EXTENSION vector — it's a no-op cost when unused.
```

Plus, in the Qdrant Cloud dashboard, delete the `olander-catalog` collection (or just leave it — Free tier doesn't bill at rest).

Revert the schema/tool/system-prompt commits. The cron auto-disables once `vercel.json` no longer lists it.

## Changing the embedding model

If we decide to re-embed everything on a new Voyage release:

1. Update `VOYAGE_DOC_MODEL` and `VOYAGE_QUERY_MODEL` in `src/lib/ai/embeddings.ts`.
2. Bump the embed-input format if needed (changes the hash → forces re-embed).
3. Run `npx tsx scripts/backfill-catalog.ts`. The hash mismatch re-embeds every row; the script Qdrant-upserts (overwriting in place by ID) and then refreshes the Neon `embed_input_hash`. Lock-step ordering ensures no inconsistency.

The 200M Voyage free tier comfortably covers a full re-embed of Olander's ~3M-token catalog several hundred times.

**Dim change requires a new Qdrant collection.** Qdrant collections are fixed-dim at creation. If a future Voyage model lands in a different shared space, edit `QDRANT_DIM` in `src/lib/ai/qdrant.ts`, point `QDRANT_COLLECTION` at a fresh collection (e.g. `olander-catalog-1536`), and re-backfill into the new one. Delete the old collection after cutover.

## Cost notes

**Voyage 4 list pricing (2026):**

- voyage-4-large: $0.12 / MTok
- voyage-4: $0.06 / MTok
- voyage-4-lite: $0.02 / MTok

First 200M tokens free per account, applied across the whole Voyage 4 family. Olander's projected steady state: ~25K doc tokens/day from incremental sync + ~1M query tokens/month from chat. We sit inside the free tier for years. The hard-coded `MAX_BACKFILL_TOKENS = 50_000_000` cap bounds the worst case of a runaway loop, not because we'd otherwise spend serious money.

**Qdrant Cloud Free tier (2026):**

- 1 cluster, 4 GB storage, single-node, forever free, no card required
- ~1M vectors at 1024-dim uncompressed comfortably fits; Olander's ~99K sits at ~700 MB with ~5× headroom
- Free tier has no read pricing — usage is unmetered against the cluster's compute
