// Voyage AI embeddings wrapper.
//
// Asymmetric retrieval per docs/RETRIEVAL.md:
//   - embedDocuments → voyage-4-large, input_type="document". Used by the
//     backfill and sync scripts. The cost compounds across every future query,
//     so spend on quality once.
//   - embedQuery     → voyage-4-lite,  input_type="query".    Used by the
//     searchCatalog tool on the hot request path. The cost runs forever, so
//     stay cheap.
//
// Voyage 4 (released Jan 2026) puts the entire family in a single shared
// 1024-dim embedding space, so document and query vectors are directly
// comparable in pgvector. `output_dimension=1024` is pinned on every call so
// a silent vendor default change can never write a mis-shaped vector into the
// vector(1024) column.
//
// We hit api.voyageai.com directly, not Vercel AI Gateway. Embeddings live
// inside Voyage's 200M-token free tier (~years of catalog churn); routing
// them through the Gateway would burn shared promo credit on the cheap
// workload and starve the workload (Claude chat) where the credit matters.

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_DOC_MODEL = "voyage-4-large";
const VOYAGE_QUERY_MODEL = "voyage-4-lite";
const VOYAGE_DIM = 1024;
const VOYAGE_TIMEOUT_MS = 30_000;
const VOYAGE_RETRY_DELAY_MS = 750;

type VoyageRequest = {
  input: string[];
  model: string;
  input_type: "document" | "query";
  output_dimension: number;
};

type VoyageResponse = {
  data: Array<{ embedding: number[]; index: number }>;
  usage: { total_tokens: number };
  model?: string;
};

class VoyageError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number,
    public readonly detail?: string,
  ) {
    super(message);
  }
}

function getApiKey(): string {
  const key = process.env.VOYAGE_API_KEY?.trim();
  if (!key) {
    throw new VoyageError("VOYAGE_API_KEY is not set", "config_missing");
  }
  return key;
}

async function voyageRequest(body: VoyageRequest): Promise<VoyageResponse> {
  const apiKey = getApiKey();

  const doFetch = async (): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), VOYAGE_TIMEOUT_MS);
    try {
      return await fetch(VOYAGE_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let resp: Response;
  try {
    resp = await doFetch();
  } catch {
    // Transient — retry once after a short pause. Cleanly distinguishes from
    // a hard 4xx (no retry) which we drop straight through to the caller.
    await new Promise((r) => setTimeout(r, VOYAGE_RETRY_DELAY_MS));
    resp = await doFetch();
  }

  if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
    // Server-side transient. Single retry; if it fails again we surface it.
    await new Promise((r) => setTimeout(r, VOYAGE_RETRY_DELAY_MS));
    resp = await doFetch();
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new VoyageError(
      `voyage_http_${resp.status}`,
      "voyage_http_error",
      resp.status,
      detail.slice(0, 500),
    );
  }

  let parsed: VoyageResponse;
  try {
    parsed = (await resp.json()) as VoyageResponse;
  } catch {
    throw new VoyageError("voyage_non_json", "voyage_non_json");
  }

  if (!Array.isArray(parsed.data) || parsed.data.length === 0) {
    throw new VoyageError("voyage_empty_response", "voyage_empty_response");
  }

  // Voyage is allowed to reorder by `index`; sort defensively. Without this,
  // a future API change could silently misalign vectors to inputs.
  parsed.data.sort((a, b) => a.index - b.index);

  for (const row of parsed.data) {
    if (!Array.isArray(row.embedding) || row.embedding.length !== VOYAGE_DIM) {
      throw new VoyageError(
        `voyage_bad_dim_${row.embedding?.length ?? "missing"}`,
        "voyage_bad_dim",
      );
    }
  }

  return parsed;
}

/** Embed catalog rows with voyage-4-large. Used by backfill + sync only. */
export async function embedDocuments(
  texts: string[],
): Promise<{ vectors: number[][]; totalTokens: number }> {
  if (texts.length === 0) return { vectors: [], totalTokens: 0 };
  const parsed = await voyageRequest({
    input: texts,
    model: VOYAGE_DOC_MODEL,
    input_type: "document",
    output_dimension: VOYAGE_DIM,
  });
  return {
    vectors: parsed.data.map((d) => d.embedding),
    totalTokens: parsed.usage?.total_tokens ?? 0,
  };
}

/** Embed a single user query with voyage-4-lite. Used by searchCatalog. */
export async function embedQuery(text: string): Promise<number[]> {
  const parsed = await voyageRequest({
    input: [text],
    model: VOYAGE_QUERY_MODEL,
    input_type: "query",
    output_dimension: VOYAGE_DIM,
  });
  return parsed.data[0].embedding;
}

/** Serialize a vector to the pgvector text literal "[a,b,c]". */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/** Build the stable embed-input text for a catalog row. See docs/RETRIEVAL.md
 * § What we embed for the rationale. */
export function buildEmbedInput(row: {
  item_id: string;
  item_desc?: string | null;
  extended_desc?: string | null;
  sales_pricing_unit?: string | null;
}): string {
  const lines: string[] = [`SKU: ${row.item_id}`];

  const desc = (row.item_desc ?? "").trim();
  if (desc) lines.push(`Description: ${desc}`);

  // Skip extended_desc when it's empty, a bare RoHS marker, or a pure
  // numeric tolerance — those add zero signal and dilute the vector. Live
  // sampling (2026-05-12) showed ~25% of populated rows fall into one of
  // those buckets. See docs/RETRIEVAL.md § What we embed.
  const ext = (row.extended_desc ?? "").trim();
  const extRedundant = ext === desc;
  const extIsJunk =
    /^non-?rohs$/i.test(ext) ||
    /^rohs$/i.test(ext) ||
    /^[\d.\-\s]+$/.test(ext);
  if (ext && !extIsJunk && !extRedundant) {
    lines.push(`Details: ${ext}`);
  }

  const uom = (row.sales_pricing_unit ?? "").trim();
  if (uom) lines.push(`UOM: ${uom}`);

  return lines.join("\n");
}

/** SHA-256 (hex) of the embed input. Same input ⇒ same hash ⇒ no re-embed. */
export async function embedInputHash(text: string): Promise<string> {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export { VOYAGE_DIM, VOYAGE_DOC_MODEL, VOYAGE_QUERY_MODEL, VoyageError };
