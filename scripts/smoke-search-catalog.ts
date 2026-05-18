// End-to-end smoke test for the searchCatalog tool, post Qdrant migration.
//
// Uses 20 hand-picked Olander-shaped rows in an isolated Qdrant collection
// (so it can't pollute production vectors) plus a synthetic UID range in
// Neon's catalog_item table for parity with the real backfill. Embeds with
// voyage-4-large, queries with voyage-4-lite (1024d shared space), confirms
// the obvious SKU lands at rank 1 in top-3.
//
// Run with:
//   npx tsx --env-file=.env.local scripts/smoke-search-catalog.ts
//
// Always cleans up — even on assertion failure — so reruns are safe.

import { config } from "dotenv";
config({ path: ".env.local", override: true });

const SMOKE_COLLECTION = "olander-catalog-smoke";
const UID_BASE = 999_000_000;

type SampleRow = {
  item_id: string;
  item_desc: string;
  extended_desc: string | null;
  sales_pricing_unit: string;
};

const SAMPLE_ROWS: SampleRow[] = [
  { item_id: "PN12345-01", item_desc: "100-PC M4 X 4 SOC SHOULDER SCREW SST",
    extended_desc: "3MM THREAD W/IFI-524 PATCH SOLD BY BAG OF 100 PCS",
    sales_pricing_unit: "BG" },
  { item_id: "M10-50-SST-CAP", item_desc: "M10X50 SOC CAP SCREW SST",
    extended_desc: "M10 X 50MM Socket Cap Head Stainless Steel A2-70",
    sales_pricing_unit: "EA" },
  { item_id: "M10-30-SST-CAP", item_desc: "M10X30 SOC CAP SCREW SST",
    extended_desc: "M10 X 30MM Socket Cap Head Stainless Steel A2-70",
    sales_pricing_unit: "EA" },
  { item_id: "M10-FW-DIN125", item_desc: "M10 F/W DIN125A STL ZNC",
    extended_desc: "M10 Flat Washer DIN125A Steel Zinc Plated",
    sales_pricing_unit: "BX" },
  { item_id: "6C100SFIS", item_desc: "6-32 X 1 SLOT FILL SST RoHS",
    extended_desc: "6-32 X 1 Slot Fillister Head Stainless Steel RoHS",
    sales_pricing_unit: "EA" },
  { item_id: ".032SW", item_desc: ".032 DIASAFETY WIRE 302 SST",
    extended_desc: null, sales_pricing_unit: "EA" },
  { item_id: "HELI-M8-INS", item_desc: "HELI-COIL INS M8X1.25 X 1.5D SST",
    extended_desc: "Heli-Coil Insert M8 x 1.25 1.5D Stainless Steel",
    sales_pricing_unit: "EA" },
  { item_id: "HELI-M10-INS", item_desc: "HELI-COIL INS M10X1.5 X 1.5D SST",
    extended_desc: "Heli-Coil Insert M10 x 1.5 1.5D Stainless Steel",
    sales_pricing_unit: "EA" },
  { item_id: "AS-NICKEL-8OZ", item_desc: "ANTI-SEIZE NICKEL HI TEMP 8OZ",
    extended_desc: "Nickel-Based Anti-Seize Compound High Temperature 8 oz",
    sales_pricing_unit: "EA" },
  { item_id: "PH-WS-1.5", item_desc: 'PHIL WOOD SCREW 1.5"',
    extended_desc: "Phillips Drive Wood Screw 1-1/2 inch",
    sales_pricing_unit: "BX" },
  { item_id: "TAP-M10-STI", item_desc: "M10X1.5 STI TAP",
    extended_desc: "M10 x 1.5 Screw Thread Insert (STI) Tap",
    sales_pricing_unit: "EA" },
  { item_id: "DRILL-21-64", item_desc: "21/64 JOBBER DRILL HSS",
    extended_desc: "21/64 inch Jobber Length Drill Bit HSS",
    sales_pricing_unit: "EA" },
  { item_id: "M6-25-SST-BTN", item_desc: "M6X25 BTN HEAD CAP SCREW SST",
    extended_desc: "M6 X 25MM Button Head Cap Screw Stainless Steel",
    sales_pricing_unit: "EA" },
  { item_id: "1/4-20-HEX-SST", item_desc: "1/4-20 X 1 HEX CAP SCREW SST",
    extended_desc: "1/4-20 x 1 inch Hex Cap Screw Stainless Steel",
    sales_pricing_unit: "BX" },
  { item_id: "M4-LW-SPLIT", item_desc: "M4 SPLIT LOCK WASHER STL",
    extended_desc: "M4 Split Lock Washer Steel Zinc",
    sales_pricing_unit: "BX" },
  { item_id: "NUT-M10-NYLOC", item_desc: "M10 NYLOC NUT SST",
    extended_desc: "M10 Nylon-Insert Lock Nut Stainless Steel",
    sales_pricing_unit: "BX" },
  { item_id: "NUT-1/4-20-HEX", item_desc: "1/4-20 HEX NUT STL ZNC",
    extended_desc: "1/4-20 Hex Nut Steel Zinc Plated",
    sales_pricing_unit: "BX" },
  { item_id: "RIVET-1/8-AL", item_desc: '1/8" POP RIVET ALUM',
    extended_desc: "1/8 inch Aluminum Pop Rivet",
    sales_pricing_unit: "BX" },
  { item_id: "BOLT-A325-3/4", item_desc: '3/4" A325 STRUCTURAL BOLT',
    extended_desc: "3/4 inch A325 Heavy Hex Structural Bolt",
    sales_pricing_unit: "BX" },
  { item_id: "MS-RED-LOCTITE", item_desc: "RED LOCTITE 271 50ML THREADLOCKER",
    extended_desc: "Red Loctite 271 High-Strength Thread Locker 50ml",
    sales_pricing_unit: "EA" },
];

type QueryCase = { query: string; expected: string };

const QUERIES: QueryCase[] = [
  { query: "M10 stainless cap screw around 50mm", expected: "M10-50-SST-CAP" },
  { query: "M10 flat washer steel", expected: "M10-FW-DIN125" },
  { query: "anti-seize for high temperature bolts", expected: "AS-NICKEL-8OZ" },
  { query: "heli coil insert M10", expected: "HELI-M10-INS" },
  { query: "phillips wood screw 1.5 inch", expected: "PH-WS-1.5" },
  { query: "safety wire 302 stainless", expected: ".032SW" },
  { query: "1/4-20 hex nut zinc", expected: "NUT-1/4-20-HEX" },
  { query: "red threadlocker like loctite 271", expected: "MS-RED-LOCTITE" },
  { query: "M10 nyloc nut", expected: "NUT-M10-NYLOC" },
  { query: "M8 helicoil insert stainless", expected: "HELI-M8-INS" },
];

async function main() {
  const { embedDocuments, embedQuery, buildEmbedInput } = await import(
    "@/lib/ai/embeddings"
  );
  const { getQdrantClient, QDRANT_DIM, QDRANT_DISTANCE, vectorIdFor } =
    await import("@/lib/ai/qdrant");
  const client = getQdrantClient();

  let fail = 0;
  try {
    // Isolated collection per run; drop it at the end whether we pass or fail.
    const existing = await client.getCollections();
    if (existing.collections.some((c) => c.name === SMOKE_COLLECTION)) {
      await client.deleteCollection(SMOKE_COLLECTION);
    }
    await client.createCollection(SMOKE_COLLECTION, {
      vectors: { size: QDRANT_DIM, distance: QDRANT_DISTANCE },
    });
    await client.createPayloadIndex(SMOKE_COLLECTION, {
      field_name: "delete_flag",
      field_schema: "bool",
      wait: true,
    });

    console.log("[smoke] embedding sample rows with voyage-4-large…");
    const texts = SAMPLE_ROWS.map(buildEmbedInput);
    const { vectors, totalTokens } = await embedDocuments(texts);
    console.log(`[smoke] ${vectors.length} doc vectors, ${totalTokens} tokens`);

    console.log(`[smoke] upserting into Qdrant collection '${SMOKE_COLLECTION}'…`);
    await client.upsert(SMOKE_COLLECTION, {
      wait: true,
      points: SAMPLE_ROWS.map((row, i) => ({
        id: vectorIdFor(UID_BASE + i),
        vector: vectors[i],
        payload: {
          item_id: row.item_id,
          item_desc: row.item_desc,
          ...(row.extended_desc ? { extended_desc: row.extended_desc } : {}),
          sales_pricing_unit: row.sales_pricing_unit,
          delete_flag: false,
        },
      })),
    });

    // Voyage paid tier handles parallel embeds fine; if you're back on the
    // 3 RPM no-billing tier override with VOYAGE_QPS_DELAY_MS=22000.
    const QPS_DELAY_MS = Number(process.env.VOYAGE_QPS_DELAY_MS ?? 0);

    let first = true;
    for (const { query, expected } of QUERIES) {
      if (!first && QPS_DELAY_MS > 0)
        await new Promise((r) => setTimeout(r, QPS_DELAY_MS));
      first = false;

      const vec = await embedQuery(query);
      const result = await client.search(SMOKE_COLLECTION, {
        vector: vec,
        limit: 3,
        with_payload: true,
        filter: { must: [{ key: "delete_flag", match: { value: false } }] },
      });

      const top3 = result.map((m) => ({
        item_id:
          typeof m.payload?.item_id === "string"
            ? (m.payload.item_id as string)
            : "",
        score: m.score ?? 0,
      }));
      const summary = top3
        .map((r) => `${r.item_id}@${r.score.toFixed(3)}`)
        .join(", ");
      const rank = top3.findIndex((r) => r.item_id === expected) + 1;

      if (rank > 0) {
        console.log(
          `[smoke] PASS  rank=${rank}  q="${query}"  top3=[${summary}]`,
        );
      } else {
        console.log(
          `[smoke] FAIL  expected=${expected}  q="${query}"  top3=[${summary}]`,
        );
        fail += 1;
      }
    }
  } finally {
    // Clean up. Always.
    try {
      await client.deleteCollection(SMOKE_COLLECTION);
      console.log(`[smoke] cleaned up Qdrant collection '${SMOKE_COLLECTION}'`);
    } catch (e) {
      console.warn("[smoke] cleanup warn:", e instanceof Error ? e.message : e);
    }
  }

  if (fail > 0) {
    console.error(`[smoke] FAILED: ${fail}/${QUERIES.length} queries missed`);
    process.exit(1);
  }
  console.log(`[smoke] ALL ${QUERIES.length} QUERIES PASS`);
}

main().catch((err) => {
  console.error("[smoke] CRASH:", err);
  process.exit(1);
});
