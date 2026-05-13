// Idempotent create-or-confirm of the Pinecone catalog index.
//
// Usage:
//   npx tsx scripts/create-pinecone-index.ts
//
// Creates the index on first run; on subsequent runs prints the current
// status and exits cleanly. Serverless on AWS us-east-1 (matches Vercel)
// keeps query latency under ~30ms from the edge runtime.

import { config } from "dotenv";
config({ path: ".env.local", override: true });

async function main() {
  const {
    getPineconeClient,
    PINECONE_INDEX_NAME,
    PINECONE_CLOUD,
    PINECONE_REGION,
    PINECONE_DIM,
    PINECONE_METRIC,
  } = await import("@/lib/ai/pinecone");

  const pc = getPineconeClient();
  const existing = await pc.listIndexes();
  const found = existing.indexes?.find((i) => i.name === PINECONE_INDEX_NAME);

  if (found) {
    console.log(
      `[pinecone] index '${PINECONE_INDEX_NAME}' already exists ` +
        `(${found.dimension}d ${found.metric}, status=${found.status?.state})`,
    );
    if (found.dimension !== PINECONE_DIM) {
      console.error(
        `[pinecone] DIM MISMATCH: have ${found.dimension}, want ${PINECONE_DIM}`,
      );
      process.exit(1);
    }
    if (found.metric !== PINECONE_METRIC) {
      console.error(
        `[pinecone] METRIC MISMATCH: have ${found.metric}, want ${PINECONE_METRIC}`,
      );
      process.exit(1);
    }
    return;
  }

  console.log(
    `[pinecone] creating '${PINECONE_INDEX_NAME}' (${PINECONE_DIM}d ${PINECONE_METRIC} ` +
      `serverless ${PINECONE_CLOUD}/${PINECONE_REGION})…`,
  );
  await pc.createIndex({
    name: PINECONE_INDEX_NAME,
    dimension: PINECONE_DIM,
    metric: PINECONE_METRIC,
    spec: { serverless: { cloud: PINECONE_CLOUD, region: PINECONE_REGION } },
    waitUntilReady: true,
  });
  console.log(`[pinecone] '${PINECONE_INDEX_NAME}' ready`);
}

main().catch((err) => {
  console.error("[pinecone] FAILED:", err);
  process.exit(1);
});
