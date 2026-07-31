// Incremental catalog sync. Designed for daily cron at ~02:00–03:00 PT.
//
// Usage:
//   npx tsx scripts/sync-catalog.ts                       # incremental, plus weekly reconcile if Sunday PT
//   FORCE_FULL_RECONCILE=1 npx tsx scripts/sync-catalog.ts # run the reconcile regardless of day
//
// Logic:
//   1. Read MAX(source_modified_at) from catalog_item.
//   2. viewsQuery p21_view_inv_mast filtered on date_last_modified ge <max>.
//      `ge` not `gt`: date_last_modified is second-resolution, multiple rows
//      can share the exact boundary value, and `gt` would silently skip them.
//      Re-fetching boundary rows is free because the hash dedupe skips
//      already-embedded content.
//   3. Same embed + upsert path as the backfill.
//   4. Soft-delete two ways:
//      a) delete_flag=true rows in the proxy response → mark deleted in our
//         table (we keep the row; queries already filter delete_flag=false).
//      b) (Weekly, Sundays PT, or FORCE_FULL_RECONCILE=1) pull every
//         inv_mast_uid from the proxy, diff against catalog_item, and mark
//         the missing ones deleted.
//
// See docs/RETRIEVAL.md § Incremental sync. The HTTP equivalent of this script
// lives at /api/cron/sync-catalog and is what production hits — keep them in
// step when changing logic.

import { config } from "dotenv";
config({ path: ".env.local", override: true });

const PAGE = 200;
const EMBED_BATCH = 100;
const MAX_TOKENS = 50_000_000;
const MAX_DURATION_MS = 30 * 60_000;
const DOC_COST_PER_MTOK_USD = 0.12;

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
  date_last_modified: string | null;
};

async function proxyPost<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${PROXY_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PROXY_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`proxy ${resp.status}: ${detail.slice(0, 200)}`);
  }
  return (await resp.json()) as T;
}

function parseP21Date(s: string | null | undefined): Date | null {
  if (!s) return null;
  const isoish = s.includes("T") ? s : s.replace(" ", "T");
  const withZ = /Z$/.test(isoish) ? isoish : `${isoish}Z`;
  const d = new Date(withZ);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toOdataDatetime(d: Date): string {
  const iso = d.toISOString().replace(/\.\d+Z$/, "").replace(/Z$/, "");
  return `datetime'${iso}'`;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function main() {
  // Dynamic imports so the dotenv config above runs before @/db reads
  // DATABASE_URL at module-load. Same workaround as scripts/verify-persistence.ts.
  const { eq, inArray, sql } = await import("drizzle-orm");
  const { db } = await import("@/db");
  const { catalogItem } = await import("@/db/schema");
  const { embedDocuments, buildEmbedInput, embedInputHash } = await import(
    "@/lib/ai/embeddings"
  );
  const { setCatalogPayload, upsertCatalogPoints, vectorIdFor } = await import(
    "@/lib/ai/qdrant"
  );

  async function* paginate(filter: string | undefined) {
    let skip = 0;
    while (true) {
      const { rows } = await proxyPost<{ rows: InvMastRow[] }>(
        "/proxy/views/p21_view_inv_mast",
        {
          select: [
            "inv_mast_uid",
            "item_id",
            "item_desc",
            "extended_desc",
            "sales_pricing_unit",
            "delete_flag",
            "date_last_modified",
          ],
          filter,
          orderBy: "inv_mast_uid",
          top: PAGE,
          skip,
        },
      );
      if (rows.length === 0) return;
      yield rows;
      skip += rows.length;
      if (rows.length < PAGE) return;
    }
  }

  async function syncIncremental() {
    const start = Date.now();
    let tokens = 0;
    let embedded = 0;
    let skipped = 0;
    let softDeleted = 0;

    const [{ maxModified }] = await db
      .select({
        maxModified: sql<Date | null>`MAX(${catalogItem.sourceModifiedAt})`,
      })
      .from(catalogItem);

    const filter = maxModified
      ? `date_last_modified ge ${toOdataDatetime(maxModified)}`
      : undefined;
    console.log(`[sync] incremental filter: ${filter ?? "<full sweep>"}`);

    for await (const rows of paginate(filter)) {
      if (Date.now() - start > MAX_DURATION_MS) {
        console.warn("[sync] BAIL: MAX_DURATION_MS exceeded");
        break;
      }
      if (tokens > MAX_TOKENS) {
        console.warn("[sync] BAIL: MAX_TOKENS exceeded");
        break;
      }

      const candidates = await Promise.all(
        rows.map(async (row) => {
          const text = buildEmbedInput({
            item_id: row.item_id,
            item_desc: row.item_desc,
            extended_desc: row.extended_desc,
            sales_pricing_unit: row.sales_pricing_unit,
          });
          return {
            row,
            text,
            hash: await embedInputHash(text),
            modifiedAt: parseP21Date(row.date_last_modified),
          };
        }),
      );

      const uids = candidates.map((c) => c.row.inv_mast_uid);
      const existing = await db
        .select({
          uid: catalogItem.invMastUid,
          hash: catalogItem.embedInputHash,
          wasDeleted: catalogItem.deleteFlag,
        })
        .from(catalogItem)
        .where(inArray(catalogItem.invMastUid, uids));

      const existingByUid = new Map(existing.map((e) => [e.uid, e]));

      // Soft-delete path (a): proxy reports delete_flag=true → mark deleted
      // in both Neon (audit) and Qdrant (filtered at query time).
      // We don't re-embed; only the payload changes.
      const newlyDeleted = candidates.filter(
        (c) =>
          c.row.delete_flag === true &&
          existingByUid.get(c.row.inv_mast_uid)?.wasDeleted === false,
      );
      for (const c of newlyDeleted) {
        await db
          .update(catalogItem)
          .set({ deleteFlag: true, sourceModifiedAt: c.modifiedAt })
          .where(eq(catalogItem.invMastUid, c.row.inv_mast_uid));
        await setCatalogPayload(vectorIdFor(c.row.inv_mast_uid), {
          delete_flag: true,
        });
        softDeleted += 1;
      }

      const toEmbed = candidates.filter(
        (c) => existingByUid.get(c.row.inv_mast_uid)?.hash !== c.hash,
      );
      skipped += candidates.length - toEmbed.length;

      if (toEmbed.length > 0) {
        for (const batch of chunk(toEmbed, EMBED_BATCH)) {
          const { vectors, totalTokens } = await embedDocuments(
            batch.map((b) => b.text),
          );
          tokens += totalTokens;
          // Qdrant first — if it fails we want Neon's hash to remain stale
          // so the next sync retries this batch.
          await upsertCatalogPoints(
            batch.map((b, i) => ({
              id: vectorIdFor(b.row.inv_mast_uid),
              vector: vectors[i],
              payload: {
                item_id: b.row.item_id,
                item_desc: b.row.item_desc ?? "",
                ...(b.row.extended_desc
                  ? { extended_desc: b.row.extended_desc }
                  : {}),
                ...(b.row.sales_pricing_unit
                  ? { sales_pricing_unit: b.row.sales_pricing_unit }
                  : {}),
                delete_flag: Boolean(b.row.delete_flag),
              },
            })),
          );
          await db
            .insert(catalogItem)
            .values(
              batch.map((b) => ({
                invMastUid: b.row.inv_mast_uid,
                itemId: b.row.item_id,
                itemDesc: b.row.item_desc,
                extendedDesc: b.row.extended_desc,
                salesPricingUnit: b.row.sales_pricing_unit,
                deleteFlag: Boolean(b.row.delete_flag),
                sourceModifiedAt: b.modifiedAt,
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
          embedded += batch.length;
        }
      }
    }

    return { embedded, skipped, softDeleted, tokens };
  }

  async function fullUidReconcile() {
    console.log("[sync] running weekly full UID reconcile");
    const upstream = new Set<number>();
    let skip = 0;
    while (true) {
      const { rows } = await proxyPost<{ rows: Array<{ inv_mast_uid: number }> }>(
        "/proxy/views/p21_view_inv_mast",
        {
          select: ["inv_mast_uid"],
          orderBy: "inv_mast_uid",
          top: PAGE,
          skip,
        },
      );
      if (rows.length === 0) break;
      for (const r of rows) upstream.add(r.inv_mast_uid);
      skip += rows.length;
      if (rows.length < PAGE) break;
    }
    console.log(`[sync] reconcile: ${upstream.size} upstream UIDs`);

    const ours = await db
      .select({ uid: catalogItem.invMastUid, deleted: catalogItem.deleteFlag })
      .from(catalogItem);

    const vanishedUids = ours
      .filter((r) => !r.deleted && !upstream.has(r.uid))
      .map((r) => r.uid);

    if (vanishedUids.length === 0) {
      console.log("[sync] reconcile: 0 vanished");
      return { vanished: 0 };
    }

    for (const batch of chunk(vanishedUids, 1000)) {
      await db
        .update(catalogItem)
        .set({ deleteFlag: true })
        .where(inArray(catalogItem.invMastUid, batch));
    }
    // Qdrant payload update is per-record. Slow but only runs weekly and
    // typically touches few rows — vanished UIDs are rare. If this ever
    // becomes a hot path, switch to a single setPayload with a points filter
    // (or delete the points outright; we lose audit).
    for (const uid of vanishedUids) {
      await setCatalogPayload(vectorIdFor(uid), { delete_flag: true });
    }
    console.log(`[sync] reconcile: marked ${vanishedUids.length} as deleted`);
    return { vanished: vanishedUids.length };
  }

  const start = Date.now();
  console.log(`[sync] starting at ${new Date().toISOString()}`);

  const incr = await syncIncremental();
  console.log(
    `[sync] incremental done: embedded=${incr.embedded} skipped=${incr.skipped}` +
      ` softDeleted=${incr.softDeleted} tokens=${incr.tokens} ` +
      `(~$${((incr.tokens * DOC_COST_PER_MTOK_USD) / 1_000_000).toFixed(4)} hypothetical)`,
  );

  const isSunday =
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "short",
    }).format(new Date()) === "Sun";
  const force = process.env.FORCE_FULL_RECONCILE === "1";

  if (isSunday || force) {
    const r = await fullUidReconcile();
    console.log(`[sync] reconcile done: vanished=${r.vanished}`);
  } else {
    console.log("[sync] not Sunday (PT), skipping full reconcile");
  }

  console.log(`[sync] done in ${Math.round((Date.now() - start) / 1000)}s`);
}

main().catch((err) => {
  console.error("[sync] FAILED:", err);
  process.exit(1);
});
