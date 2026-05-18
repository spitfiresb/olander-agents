// Idempotent: create the catalog collection in Qdrant if it doesn't already
// exist, and ensure the payload index on `delete_flag` is in place so the
// searchCatalog filter doesn't fall back to a payload scan. Safe to re-run.
//
// Run with:  npx tsx --env-file=.env.local scripts/create-qdrant-collection.ts

import {
  QDRANT_COLLECTION,
  QDRANT_DIM,
  QDRANT_DISTANCE,
  getQdrantClient,
} from "../src/lib/ai/qdrant";

async function main() {
  const client = getQdrantClient();

  const existing = await client.getCollections();
  const found = existing.collections.find((c) => c.name === QDRANT_COLLECTION);

  if (!found) {
    console.log(`[qdrant] creating collection "${QDRANT_COLLECTION}" …`);
    await client.createCollection(QDRANT_COLLECTION, {
      vectors: { size: QDRANT_DIM, distance: QDRANT_DISTANCE },
    });
    console.log(`[qdrant] collection created`);
  } else {
    const info = await client.getCollection(QDRANT_COLLECTION);
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
        `[qdrant] collection "${QDRANT_COLLECTION}" exists with wrong shape: ` +
          `dim=${size} distance=${distance}, want dim=${QDRANT_DIM} distance=${QDRANT_DISTANCE}`,
      );
    }
    console.log(
      `[qdrant] collection "${QDRANT_COLLECTION}" already exists (${size}d ${distance})`,
    );
  }

  // Payload index on delete_flag: without it the searchCatalog filter
  // ({ delete_flag: false }) forces a payload scan per query, which gets
  // slow once the collection has more than a few thousand points.
  try {
    await client.createPayloadIndex(QDRANT_COLLECTION, {
      field_name: "delete_flag",
      field_schema: "bool",
      wait: true,
    });
    console.log(`[qdrant] payload index on delete_flag ready`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The Qdrant client throws on "already exists" — treat as success.
    if (/already exists|already_exists/i.test(msg)) {
      console.log(`[qdrant] payload index on delete_flag already exists`);
    } else {
      throw e;
    }
  }

  const stats = await client.getCollection(QDRANT_COLLECTION);
  console.log(
    `[qdrant] points: ${stats.points_count ?? 0}  indexed: ${stats.indexed_vectors_count ?? 0}  status: ${stats.status}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
