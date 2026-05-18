import { NextResponse } from "next/server";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { catalogItem } from "@/db/schema";
import {
  embedDocuments,
  buildEmbedInput,
  embedInputHash,
} from "@/lib/ai/embeddings";
import {
  qdrantConfigured,
  setCatalogPayload,
  upsertCatalogPoints,
  vectorIdFor,
} from "@/lib/ai/qdrant";

// Daily catalog sync. Wired in vercel.json to fire at 10:00 UTC
// (02:00 PST / 03:00 PDT — pre-dawn for Olander reps so a fresh index
// is ready by 7am). See RETRIEVAL.md § Incremental sync.
//
// Vercel sends `Authorization: Bearer ${CRON_SECRET}` on every cron-triggered
// request (when CRON_SECRET is set in project env). We gate on that token so
// the endpoint isn't a publicly-callable embedding budget drain.

export const dynamic = "force-dynamic";
export const revalidate = 0;
// 300s is Vercel's Hobby cap (Pro allows up to 900). A full re-embed of
// the ~99K-row catalog blows past this — that's fine because the daily
// cron is incremental: only rows whose source has changed since the last
// sync are re-embedded, which is normally a handful per run. If a mass
// re-embed is ever needed (Voyage release with new dim, schema flip),
// run scripts/backfill-catalog.ts locally where there's no time budget.
export const maxDuration = 300;

const PAGE = 200;
const EMBED_BATCH = 100;
const MAX_TOKENS = 50_000_000;
// Bail well inside maxDuration so the loop's "finishing batch" graceful
// exit always wins over Vercel's hard kill.
const MAX_DURATION_MS = 270 * 1000;

const PROXY_URL = (process.env.DROPLET_PROXY_URL ?? "").replace(/\/+$/, "");
const PROXY_TOKEN = process.env.DROPLET_PROXY_TOKEN ?? "";

type InvMastRow = {
  inv_mast_uid: number;
  item_id: string;
  item_desc: string | null;
  extended_desc: string | null;
  sales_pricing_unit: string | null;
  delete_flag: boolean;
  date_last_modified: string | null;
};

function checkAuth(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  // Constant-time-ish compare — Node's crypto.timingSafeEqual works on equal
  // lengths, so reject mismatched lengths up front.
  const presented = header.slice(7).trim();
  if (presented.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ secret.charCodeAt(i);
  }
  return diff === 0;
}

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

async function runSync() {
  const start = Date.now();
  let tokens = 0;
  let embedded = 0;
  let skipped = 0;
  let softDeleted = 0;

  const [{ maxModified }] = await db
    .select({ maxModified: sql<Date | null>`MAX(${catalogItem.sourceModifiedAt})` })
    .from(catalogItem);

  const filter = maxModified
    ? `date_last_modified ge ${toOdataDatetime(maxModified)}`
    : undefined;

  let skip = 0;
  while (true) {
    if (Date.now() - start > MAX_DURATION_MS) break;
    if (tokens > MAX_TOKENS) break;

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
    if (rows.length === 0) break;

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

    for (const c of candidates) {
      if (
        c.row.delete_flag === true &&
        existingByUid.get(c.row.inv_mast_uid)?.wasDeleted === false
      ) {
        await db
          .update(catalogItem)
          .set({ deleteFlag: true, sourceModifiedAt: c.modifiedAt })
          .where(eq(catalogItem.invMastUid, c.row.inv_mast_uid));
        await setCatalogPayload(vectorIdFor(c.row.inv_mast_uid), {
          delete_flag: true,
        });
        softDeleted += 1;
      }
    }

    const toEmbed = candidates.filter(
      (c) => existingByUid.get(c.row.inv_mast_uid)?.hash !== c.hash,
    );
    skipped += candidates.length - toEmbed.length;

    for (const batch of chunk(toEmbed, EMBED_BATCH)) {
      const { vectors, totalTokens } = await embedDocuments(
        batch.map((b) => b.text),
      );
      tokens += totalTokens;
      // Qdrant first — if it fails, Neon keeps the stale hash and the next
      // cron retries the batch. Reversing the order would create rows that
      // claim to be embedded but aren't, which would silently miss from
      // catalog search until the row's text changes again.
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

    skip += rows.length;
    if (rows.length < PAGE) break;
  }

  return {
    embedded,
    skipped,
    softDeleted,
    tokens,
    elapsedMs: Date.now() - start,
  };
}

export async function GET(req: Request) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!PROXY_URL || !PROXY_TOKEN) {
    return NextResponse.json(
      { error: "proxy_not_configured" },
      { status: 503 },
    );
  }
  if (!process.env.VOYAGE_API_KEY) {
    return NextResponse.json(
      { error: "voyage_not_configured" },
      { status: 503 },
    );
  }
  if (!qdrantConfigured()) {
    return NextResponse.json(
      { error: "qdrant_not_configured" },
      { status: 503 },
    );
  }
  try {
    const result = await runSync();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: "sync_failed",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}
