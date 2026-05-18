// Backfill the catalog_item vector index from p21_view_inv_mast.
//
// Usage:
//   npx tsx scripts/backfill-catalog.ts          # full run
//   LIMIT=1000 npx tsx scripts/backfill-catalog.ts   # cap at 1000 rows (smoke test)
//   DRY_RUN=1 npx tsx scripts/backfill-catalog.ts    # fetch + hash, no Voyage, no DB writes
//
// Idempotent by `embed_input_hash`: re-running picks up where it stopped and
// skips rows whose content hasn't changed. Re-runs are cheap to invoke; the
// 50M-token cap is a runaway-loop circuit breaker, not a cost ceiling.
//
// See RETRIEVAL.md § Backfill script for the design.

// Dynamic imports below: ESM hoists static `import { db }` above the top-level
// dotenv `config()` call, so the Drizzle client binds to the placeholder
// DATABASE_URL. Same workaround as scripts/verify-persistence.ts.
import { config } from "dotenv";
config({ path: ".env.local", override: true });

// --- Tuning -----------------------------------------------------------------

// Proxy caps $top at 200 (see scripts/droplet/proxy-server.mjs handleViewsQuery).
// The chatbot tool wrapper caps it lower (50) for context reasons; we go to
// the proxy directly so we can use the full upstream allowance.
const PAGE = 200;
// Voyage accepts up to 1000 inputs per /embeddings call. 100 keeps in-memory
// state bounded and gives us a fast partial-failure granularity.
const EMBED_BATCH = 100;
// The droplet proxy enforces 30 req/min per IP. During the hash-dedupe phase
// (every page is a fast SELECT + no embed) we burst past that limit. 2500 ms
// between pages caps us at ~24 RPM. During the embed-heavy phase Voyage
// already dominates the page time, so the sleep is mostly absorbed.
const PAGE_DELAY_MS = Number(process.env.PAGE_DELAY_MS ?? 2500);

// Real catalog is ~3M tokens (per RETRIEVAL.md cost analysis, verified 2026-05-12).
// 50M is 15x headroom. At voyage-4-large's $0.12/MTok that would be $6 if we
// ever left the free tier — a circuit breaker for a stuck loop, not a budget.
const MAX_BACKFILL_TOKENS = 50_000_000;
// Default 30 min ceiling, override with MAX_DURATION_MIN=<n> for the rare
// case where the full ~99K backfill needs more headroom (e.g. cold Voyage).
const MAX_BACKFILL_DURATION_MS =
  Number(process.env.MAX_DURATION_MIN ?? 30) * 60_000;
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const DRY_RUN = process.env.DRY_RUN === "1";

// Cost log uses voyage-4-large's $0.12/MTok list price (the model this script
// calls). Free-tier reality is $0; the log is a sanity gauge for runaway runs.
const DOC_COST_PER_MTOK_USD = 0.12;

// --- Proxy access -----------------------------------------------------------

const PROXY_URL = (process.env.DROPLET_PROXY_URL ?? "").replace(/\/+$/, "");
const PROXY_TOKEN = process.env.DROPLET_PROXY_TOKEN ?? "";

if (!PROXY_URL || !PROXY_TOKEN) {
  console.error("DROPLET_PROXY_URL / DROPLET_PROXY_TOKEN required");
  process.exit(1);
}

type InvMastRow = {
  inv_mast_uid: number;
  item_id: string;
  item_desc: string | null;
  extended_desc: string | null;
  sales_pricing_unit: string | null;
  delete_flag: boolean;
  date_last_modified: string | null; // ISO-ish, no TZ
};

type Candidate = {
  invMastUid: number;
  itemId: string;
  itemDesc: string | null;
  extendedDesc: string | null;
  salesPricingUnit: string | null;
  deleteFlag: boolean;
  sourceModifiedAt: Date | null;
  text: string;
  hash: string;
};

async function fetchPage(skip: number): Promise<InvMastRow[]> {
  const resp = await fetch(`${PROXY_URL}/proxy/views/p21_view_inv_mast`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PROXY_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      select: [
        "inv_mast_uid",
        "item_id",
        "item_desc",
        "extended_desc",
        "sales_pricing_unit",
        "delete_flag",
        "date_last_modified",
      ],
      orderBy: "inv_mast_uid",
      top: PAGE,
      skip,
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`proxy ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { rows: InvMastRow[] };
  return data.rows ?? [];
}

// --- Helpers ----------------------------------------------------------------

// "2019-11-25T09:53:30" → Date (treated as UTC; P21 timestamps have no TZ).
function parseP21Date(s: string | null | undefined): Date | null {
  if (!s) return null;
  const isoish = s.includes("T") ? s : s.replace(" ", "T");
  const withZ = /Z$/.test(isoish) ? isoish : `${isoish}Z`;
  const d = new Date(withZ);
  return Number.isNaN(d.getTime()) ? null : d;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// --- Main loop --------------------------------------------------------------

async function main() {
  // Dynamic imports so dotenv config runs before src/db/index.ts reads
  // DATABASE_URL at module-load.
  const { inArray, sql } = await import("drizzle-orm");
  const { db } = await import("@/db");
  const { catalogItem } = await import("@/db/schema");
  const {
    embedDocuments,
    buildEmbedInput,
    embedInputHash,
  } = await import("@/lib/ai/embeddings");
  const { upsertCatalogPoints, vectorIdFor } = await import(
    "@/lib/ai/qdrant"
  );

  async function buildCandidate(row: InvMastRow): Promise<Candidate> {
    const text = buildEmbedInput({
      item_id: row.item_id,
      item_desc: row.item_desc,
      extended_desc: row.extended_desc,
      sales_pricing_unit: row.sales_pricing_unit,
    });
    const hash = await embedInputHash(text);
    return {
      invMastUid: row.inv_mast_uid,
      itemId: row.item_id,
      itemDesc: row.item_desc,
      extendedDesc: row.extended_desc,
      salesPricingUnit: row.sales_pricing_unit,
      deleteFlag: Boolean(row.delete_flag),
      sourceModifiedAt: parseP21Date(row.date_last_modified),
      text,
      hash,
    };
  }

  const start = Date.now();
  let skip = 0;
  let totalRows = 0;
  let embeddedRows = 0;
  let skippedRows = 0;
  let totalTokens = 0;

  console.log(
    `[backfill] starting (PAGE=${PAGE} EMBED_BATCH=${EMBED_BATCH}` +
      `${LIMIT ? ` LIMIT=${LIMIT}` : ""}${DRY_RUN ? " DRY_RUN" : ""})`,
  );

  while (true) {
    if (Date.now() - start > MAX_BACKFILL_DURATION_MS) {
      console.warn(
        `[backfill] BAIL: hit MAX_BACKFILL_DURATION_MS (${MAX_BACKFILL_DURATION_MS}ms)`,
      );
      process.exit(1);
    }
    if (totalTokens > MAX_BACKFILL_TOKENS) {
      console.warn(
        `[backfill] BAIL: hit MAX_BACKFILL_TOKENS (${MAX_BACKFILL_TOKENS} tokens)`,
      );
      process.exit(1);
    }

    const rows = await fetchPage(skip);
    if (rows.length === 0) {
      console.log(`[backfill] no more rows at skip=${skip}, done`);
      break;
    }
    totalRows += rows.length;

    const candidates = await Promise.all(rows.map(buildCandidate));

    // Hash-dedupe vs already-embedded rows. One SELECT per page (not per row)
    // keeps the round-trip count flat.
    const uids = candidates.map((c) => c.invMastUid);
    const existing = await db
      .select({
        uid: catalogItem.invMastUid,
        hash: catalogItem.embedInputHash,
      })
      .from(catalogItem)
      .where(inArray(catalogItem.invMastUid, uids));

    const existingByUid = new Map(existing.map((e) => [e.uid, e.hash]));
    const toEmbed = candidates.filter(
      (c) => existingByUid.get(c.invMastUid) !== c.hash,
    );
    skippedRows += candidates.length - toEmbed.length;

    if (toEmbed.length > 0) {
      if (DRY_RUN) {
        // Dry-run still walks every page and computes hashes — the point is
        // to verify pagination and hashing without touching Voyage or the DB.
        embeddedRows += toEmbed.length;
      } else {
        for (const batch of chunk(toEmbed, EMBED_BATCH)) {
          const { vectors, totalTokens: batchTokens } = await embedDocuments(
            batch.map((b) => b.text),
          );
          totalTokens += batchTokens;

          // Qdrant first, then Neon. If Qdrant fails we want the Neon
          // hash to STILL be stale so the next sync retries — never end up
          // with a Neon row claiming "embedded" while Qdrant has no vector.
          await upsertCatalogPoints(
            batch.map((b, i) => ({
              id: vectorIdFor(b.invMastUid),
              vector: vectors[i],
              payload: {
                item_id: b.itemId,
                item_desc: b.itemDesc ?? "",
                ...(b.extendedDesc ? { extended_desc: b.extendedDesc } : {}),
                ...(b.salesPricingUnit
                  ? { sales_pricing_unit: b.salesPricingUnit }
                  : {}),
                delete_flag: b.deleteFlag,
              },
            })),
          );

          // Metadata row in Neon. No embedding column anymore — Qdrant is
          // the vector store. embedInputHash + embeddedAt are still the
          // lock-step keys: hash matches ⇒ Qdrant is up to date.
          await db
            .insert(catalogItem)
            .values(
              batch.map((b) => ({
                invMastUid: b.invMastUid,
                itemId: b.itemId,
                itemDesc: b.itemDesc,
                extendedDesc: b.extendedDesc,
                salesPricingUnit: b.salesPricingUnit,
                deleteFlag: b.deleteFlag,
                sourceModifiedAt: b.sourceModifiedAt,
                embedInputHash: b.hash,
              })),
            )
            .onConflictDoUpdate({
              target: catalogItem.invMastUid,
              set: {
                itemId: sql`excluded.item_id`,
                itemDesc: sql`excluded.item_desc`,
                extendedDesc: sql`excluded.extended_desc`,
                salesPricingUnit: sql`excluded.sales_pricing_unit`,
                deleteFlag: sql`excluded.delete_flag`,
                sourceModifiedAt: sql`excluded.source_modified_at`,
                embedInputHash: sql`excluded.embed_input_hash`,
                embeddedAt: sql`now()`,
              },
            });
          embeddedRows += batch.length;
        }
      }
    }

    const dollars = (totalTokens * DOC_COST_PER_MTOK_USD) / 1_000_000;
    console.log(
      `[backfill] page skip=${skip}+${rows.length} ` +
        `embedded=${embeddedRows}/${totalRows} ` +
        `skipped=${skippedRows} tokens=${totalTokens} ` +
        `(~$${dollars.toFixed(4)} hypothetical${
          DRY_RUN ? "; dry run, no API calls" : ""
        })`,
    );

    skip += rows.length;
    if (rows.length < PAGE) break; // short page = end of view
    if (LIMIT != null && totalRows >= LIMIT) {
      console.log(`[backfill] hit LIMIT=${LIMIT}, stopping`);
      break;
    }
    if (PAGE_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    }
  }

  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(
    `[backfill] done: rows=${totalRows} embedded=${embeddedRows} ` +
      `skipped=${skippedRows} tokens=${totalTokens} elapsed=${elapsed}s`,
  );
}

main().catch((err) => {
  console.error("[backfill] FAILED:", err);
  process.exit(1);
});
