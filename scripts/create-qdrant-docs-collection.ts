// Idempotent: create the reference-document chunk collection (`olander-docs`)
// in Qdrant if it doesn't exist, and ensure the `document_id` keyword payload
// index so per-document delete (and any future filtered search) doesn't fall
// back to a payload scan. Safe to re-run.
//
// Run with:  npx tsx --env-file=.env.local scripts/create-qdrant-docs-collection.ts

import { config } from "dotenv";
config({ path: ".env.local", override: true });

async function main() {
  const { QDRANT_DOCS_COLLECTION } = await import("@/lib/ai/qdrant-docs");
  const { getQdrantClient, QDRANT_DIM, QDRANT_DISTANCE } = await import(
    "@/lib/ai/qdrant"
  );
  const client = getQdrantClient();

  const existing = await client.getCollections();
  const found = existing.collections.find(
    (c) => c.name === QDRANT_DOCS_COLLECTION,
  );

  if (!found) {
    console.log(`[qdrant] creating collection "${QDRANT_DOCS_COLLECTION}" …`);
    await client.createCollection(QDRANT_DOCS_COLLECTION, {
      vectors: { size: QDRANT_DIM, distance: QDRANT_DISTANCE },
    });
    console.log("[qdrant] collection created");
  } else {
    const info = await client.getCollection(QDRANT_DOCS_COLLECTION);
    const vectorCfg = info.config?.params?.vectors;
    const size =
      typeof vectorCfg === "object" && vectorCfg && "size" in vectorCfg
        ? (vectorCfg as { size: number }).size
        : undefined;
    const distance =
      typeof vectorCfg === "object" && vectorCfg && "distance" in vectorCfg
        ? (vectorCfg as { distance: string }).distance
        : undefined;
    if (size !== QDRANT_DIM || distance !== QDRANT_DISTANCE) {
      throw new Error(
        `[qdrant] collection "${QDRANT_DOCS_COLLECTION}" exists with wrong shape: ` +
          `dim=${size} distance=${distance}, want dim=${QDRANT_DIM} distance=${QDRANT_DISTANCE}`,
      );
    }
    console.log(
      `[qdrant] collection "${QDRANT_DOCS_COLLECTION}" already exists (${size}d ${distance})`,
    );
  }

  try {
    await client.createPayloadIndex(QDRANT_DOCS_COLLECTION, {
      field_name: "document_id",
      field_schema: "keyword",
      wait: true,
    });
    console.log("[qdrant] payload index on document_id ready");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/already exists|already_exists/i.test(msg)) {
      console.log("[qdrant] payload index on document_id already exists");
    } else {
      throw e;
    }
  }

  const stats = await client.getCollection(QDRANT_DOCS_COLLECTION);
  console.log(
    `[qdrant] points: ${stats.points_count ?? 0}  status: ${stats.status}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
