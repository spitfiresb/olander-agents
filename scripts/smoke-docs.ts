// End-to-end smoke test for the reference-document RAG pipeline:
// extract text → chunk → embed (voyage-4-large) → upsert to an isolated Qdrant
// collection → query (voyage-4-lite) and confirm the right passage comes back.
//
// Runs against a built-in synthetic handbook by default; pass a file path to
// exercise real extraction (e.g. a PDF) end to end:
//
//   npx tsx --env-file=.env.local scripts/smoke-docs.ts
//   npx tsx --env-file=.env.local scripts/smoke-docs.ts "C:\path\to\Helicoil-Catalog.pdf" "thread size for M10 insert"
//
// Always cleans up its collection, even on failure.

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { config } from "dotenv";
config({ path: ".env.local", override: true });

const SMOKE_COLLECTION = "olander-docs-smoke";

const EXT_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
};

const SYNTHETIC = `Olander Employee Handbook (excerpt)

Paid Time Off. Full-time employees accrue 15 days of paid time off per year, at 1.25 days per month. PTO must be requested at least two weeks in advance through your manager.

Returns Policy. Customer returns are accepted within 30 days of purchase with the original packing slip. Special-order and cut-to-length items are non-returnable. A 15% restocking fee applies to opened items.

Helicoil Installation. For an M10 x 1.5 thread, use the STI tap and install the insert 1.5 diameters deep. Snap off the tang after installation using a tang break tool.`;

const SYNTHETIC_QUERIES: Array<{ query: string; expect: RegExp }> = [
  { query: "how many PTO days do full-time employees get", expect: /15 days/i },
  { query: "what is the restocking fee on returns", expect: /15%/ },
  { query: "how deep do I install an M10 helicoil insert", expect: /1\.5 diameters/i },
];

async function main() {
  const fileArg = process.argv[2];
  const customQuery = process.argv[3];

  const { extractTextFromBuffer } = await import("@/lib/extract");
  const { chunkText } = await import("@/lib/ai/chunk");
  const { embedDocuments, embedQuery } = await import("@/lib/ai/embeddings");
  const { getQdrantClient, QDRANT_DIM, QDRANT_DISTANCE } = await import(
    "@/lib/ai/qdrant"
  );
  const client = getQdrantClient();

  let text: string;
  let label: string;
  if (fileArg) {
    const ext = extname(fileArg).toLowerCase();
    const mime = EXT_MIME[ext];
    if (!mime) throw new Error(`no mime mapping for extension "${ext}"`);
    const buf = readFileSync(fileArg);
    console.log(`[smoke-docs] extracting ${basename(fileArg)} (${mime}) …`);
    const extracted = await extractTextFromBuffer(buf, mime);
    text = extracted.text;
    label = basename(fileArg);
    console.log(
      `[smoke-docs] extracted ${text.length.toLocaleString()} chars` +
        (extracted.pageCount !== null ? ` from ${extracted.pageCount} pages` : ""),
    );
  } else {
    text = SYNTHETIC;
    label = "synthetic-handbook.txt";
  }

  const chunks = chunkText(text);
  console.log(`[smoke-docs] ${chunks.length} chunks`);
  if (chunks.length === 0) throw new Error("no chunks produced");

  let fail = 0;
  try {
    const existing = await client.getCollections();
    if (existing.collections.some((c) => c.name === SMOKE_COLLECTION)) {
      await client.deleteCollection(SMOKE_COLLECTION);
    }
    await client.createCollection(SMOKE_COLLECTION, {
      vectors: { size: QDRANT_DIM, distance: QDRANT_DISTANCE },
    });

    const BATCH = 96;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      const { vectors } = await embedDocuments(batch.map((c) => c.text));
      await client.upsert(SMOKE_COLLECTION, {
        wait: true,
        points: batch.map((c, j) => ({
          id: crypto.randomUUID(),
          vector: vectors[j],
          payload: { document_id: "smoke", filename: label, chunk_index: c.index, text: c.text },
        })),
      });
    }
    console.log(`[smoke-docs] upserted ${chunks.length} vectors`);

    const cases = fileArg
      ? [{ query: customQuery ?? "summary", expect: /.+/ }]
      : SYNTHETIC_QUERIES;

    for (const { query, expect } of cases) {
      const vec = await embedQuery(query);
      const res = await client.search(SMOKE_COLLECTION, {
        vector: vec,
        limit: 3,
        with_payload: true,
      });
      const top = res[0];
      const topText = typeof top?.payload?.text === "string" ? top.payload.text : "";
      const ok = expect.test(topText);
      const preview = topText.replace(/\s+/g, " ").slice(0, 90);
      if (ok) {
        console.log(`[smoke-docs] PASS  q="${query}"  top@${(top?.score ?? 0).toFixed(3)}: ${preview}`);
      } else {
        console.log(`[smoke-docs] FAIL  q="${query}"  top: ${preview}`);
        fail += 1;
      }
    }
  } finally {
    try {
      await client.deleteCollection(SMOKE_COLLECTION);
      console.log(`[smoke-docs] cleaned up '${SMOKE_COLLECTION}'`);
    } catch (e) {
      console.warn("[smoke-docs] cleanup warn:", e instanceof Error ? e.message : e);
    }
  }

  if (fail > 0) {
    console.error(`[smoke-docs] FAILED: ${fail} query(ies) missed`);
    process.exit(1);
  }
  console.log("[smoke-docs] ALL CHECKS PASS");
}

main().catch((err) => {
  console.error("[smoke-docs] CRASH:", err);
  process.exit(1);
});
