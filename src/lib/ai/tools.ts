import { tool } from "ai";
import { z } from "zod";
import { embedQuery } from "@/lib/ai/embeddings";
import { getViewSchema } from "@/lib/ai/p21-schema";
import { qdrantConfigured, searchCatalogByVector } from "@/lib/ai/qdrant";
import {
  isEntityAllowed,
  isViewAllowed,
  type EffectiveScopes,
  type ScopeCatalog,
} from "@/lib/scopes";

// Layer 3 chatbot tools. Both call the Layer 2 proxy on the droplet, which:
//   - holds the P21 credentials
//   - inherits the SNAT egress IP that the hosting provider whitelists
//   - normalizes both P21 tiers to snake_case keys + booleans + numbers
// See docs/P21_API.md for the upstream contract and scripts/droplet/proxy-server.mjs
// for the proxy implementation.

const PROXY_URL = process.env.DROPLET_PROXY_URL ?? "";
const PROXY_TOKEN = process.env.DROPLET_PROXY_TOKEN ?? "";
const PROXY_TIMEOUT_MS = 25_000;

function proxyConfigured(): boolean {
  return Boolean(PROXY_URL && PROXY_TOKEN);
}

type ProxyError =
  | { error: "proxy_not_configured" }
  | { error: "proxy_unreachable"; detail: string }
  | { error: "proxy_status"; status: number; body: unknown };

async function callProxy(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown | ProxyError> {
  if (!proxyConfigured()) return { error: "proxy_not_configured" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${PROXY_URL.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${PROXY_TOKEN}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    return { error: "proxy_unreachable", detail: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }

  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch {
    parsed = null;
  }

  if (!resp.ok) {
    return { error: "proxy_status", status: resp.status, body: parsed };
  }
  return parsed;
}

// Reject filter patterns that look like SQL injection attempts, even though
// the upstream OData service is parameterized. The proxy is a single line of
// defense; making the tool refuse obviously malformed input is a second.
const SAFE_FILTER = z
  .string()
  .max(1024, "filter too long")
  .refine((s) => !/;|--|\/\*|\*\//.test(s), "filter contains forbidden character sequence")
  .refine((s) => {
    // OData allows single-quoted string literals. Disallow stray semicolons
    // anyway and require quote balance so 'O''Brien' style escapes work.
    const stripped = s.replace(/''/g, "").replace(/'[^']*'/g, "");
    return !stripped.includes("'");
  }, "filter has unbalanced string quotes");

const SAFE_ORDER_BY = z
  .string()
  .max(128)
  .regex(/^[a-z0-9_]+(\s+(asc|desc))?$/i, "orderBy must be `<column>` or `<column> asc|desc`");

// Shape of a scope-denied tool result. The model can read `error` +
// `scope_required` and tell the rep "you'd need <scope> access for that"
// instead of retrying the same call.
type ScopeDenied =
  | {
      error: "scope_denied";
      resource: string;
      scope_required: string;
      scope_label: string;
    }
  | {
      error: "uncategorized_resource";
      resource: string;
      detail: string;
    };

function denyForView(decision: ReturnType<typeof isViewAllowed>): ScopeDenied {
  if (decision.ok) throw new Error("denyForView called on ok decision");
  if (decision.reason === "uncategorized") {
    return {
      error: "uncategorized_resource",
      resource: decision.resource,
      detail:
        "This view is not categorized into any data-access scope. Ask an admin to map it at /admin/scopes.",
    };
  }
  return {
    error: "scope_denied",
    resource: decision.resource,
    scope_required: decision.scope,
    scope_label: decision.scopeLabel,
  };
}

function denyForEntity(
  decision: ReturnType<typeof isEntityAllowed>,
): ScopeDenied {
  if (decision.ok) throw new Error("denyForEntity called on ok decision");
  if (decision.reason === "uncategorized") {
    return {
      error: "uncategorized_resource",
      resource: decision.resource,
      detail:
        "This entity route is not categorized into any data-access scope. Ask an admin to map it at /admin/scopes.",
    };
  }
  return {
    error: "scope_denied",
    resource: decision.resource,
    scope_required: decision.scope,
    scope_label: decision.scopeLabel,
  };
}

function makeViewsQuery(scopes: EffectiveScopes, catalog: ScopeCatalog) {
  return tool({
  description:
    "Run a filtered, projected, sorted query against a P21 SQL view via the droplet proxy. " +
    "The primary tool for search-style questions: which parts, which customers, which orders. " +
    "View names MUST use the p21_view_* prefix — e.g. p21_view_inv_mast (parts), " +
    "p21_view_customer (customers), p21_view_oe_hdr (sales orders), p21_view_po_hdr (POs), " +
    "p21_view_inv_loc (on-hand by location), p21_view_vendor (vendors). " +
    "Filter uses OData v3 syntax: eq, ne, gt/ge, lt/le, and, or, not, " +
    "startswith(field,'X'), endswith(field,'X'), substringof('X', field). " +
    "Wrap string literals in single quotes. Dates are typed literals: " +
    "datetime'YYYY-MM-DDTHH:MM:SS' — a bare date like 2026-06-17 is a syntax error. " +
    "Use $select to project (views are 100+ columns; " +
    "always select only what you need). Returns { rows: [...], count }; rows are snake_case " +
    "with JSON booleans, numbers parsed from numeric strings, ISO date strings, and null for nulls.",
  inputSchema: z.object({
    viewName: z
      .string()
      .regex(/^p21_view_[a-z0-9_]+$/i, "must match p21_view_* (e.g. p21_view_inv_mast)"),
    filter: SAFE_FILTER.optional().describe(
      "OData $filter expression — e.g. \"startswith(item_id,'P26') and delete_flag eq 'N'\".",
    ),
    top: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Page size. Default 20. Cap 50 — LLMs don't benefit from huge result sets and rows blow up context.",
      ),
    skip: z.number().int().min(0).max(10_000).optional(),
    select: z
      .union([
        z.string().max(512).regex(/^[a-z0-9_,\s]+$/i, "select: alphanumeric column names only"),
        z.array(z.string().regex(/^[a-z0-9_]+$/i)).max(40),
      ])
      .optional()
      .describe(
        "Comma-separated column list, or array of names. Project aggressively — views are wide.",
      ),
    orderBy: SAFE_ORDER_BY.optional().describe(
      'e.g. "item_id" or "date_created desc". Pair with skip/top for stable paging.',
    ),
  }),
  execute: async (input) => {
    const decision = isViewAllowed(input.viewName, scopes, catalog);
    if (!decision.ok) return denyForView(decision);
    const result = await callProxy("POST", `/proxy/views/${encodeURIComponent(input.viewName)}`, {
      filter: input.filter,
      top: input.top ?? 20,
      skip: input.skip,
      select: input.select,
      orderBy: input.orderBy,
    });
    return result;
  },
  });
}

function makeDescribeView(scopes: EffectiveScopes, catalog: ScopeCatalog) {
  return tool({
    description:
      "List a P21 SQL view's columns + types. Call this BEFORE viewsQuery " +
      "whenever you pick a view outside the fast-path seven (inv_mast, inv_loc, " +
      "customer, vendor, oe_hdr, oe_line, po_hdr) so you can project the right " +
      "columns in $select instead of guessing. Returns { columns: [{ name, " +
      "type, nullable, key }] }. Reads from a bundled schema snapshot — no " +
      "upstream round-trip, so it's fast and free.",
    inputSchema: z.object({
      viewName: z
        .string()
        .regex(
          /^p21_view_[a-z0-9_]+$/i,
          "must match p21_view_* (e.g. p21_view_transfer_hdr)",
        ),
    }),
    execute: async ({ viewName }) => {
      const decision = isViewAllowed(viewName, scopes, catalog);
      if (!decision.ok) return denyForView(decision);
      const view = getViewSchema(viewName);
      if (!view) {
        return {
          error: "view_not_in_schema" as const,
          viewName,
          detail:
            "View is not in the bundled P21 schema snapshot. If P21 added new views, " +
            "re-run scripts/droplet/dump-p21-schema.sh then scripts/build-p21-catalog.mjs.",
        };
      }
      return { columns: view.columns };
    },
  });
}

// Reject suspicious entity IDs (newlines, slashes, quotes) before they hit
// the proxy URL. P21 IDs are reliably alphanumeric + dashes/dots, which keeps
// us well inside what the upstream paths can encode without surprise.
const SAFE_ID = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, "id must be alphanumeric (dash/dot/underscore allowed)");

function makeEntityGet(scopes: EffectiveScopes, catalog: ScopeCatalog) {
  return tool({
  description:
    "Fetch a single full P21 entity record by ID via the droplet proxy. " +
    "Use this after a viewsQuery surfaces a row that needs more detail. " +
    "Common pairs: area='inventory', resource='v2/parts', id=<item_id> (e.g. 'PN12345-01'); " +
    "area='entity', resource='customers', id=<customer_id>; " +
    "area='sales', resource='orders', id=<order_no>. " +
    "extendedProperties is an endpoint-specific string to pull related sub-objects (locations, " +
    "suppliers, etc.) in a single call — leave empty unless you know the right value. " +
    "Returns the record as snake_case JSON. Do NOT use this for listing — calling /api/<resource>/ " +
    "without an ID times out at 30s; use viewsQuery instead.",
  inputSchema: z.object({
    area: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/i)
      .describe("e.g. 'inventory', 'entity', 'sales', 'purchasing', 'accounting'"),
    resource: z
      .string()
      .regex(/^[a-zA-Z0-9._/-]+$/)
      .describe(
        "e.g. 'v2/parts', 'customers', 'orders', 'purchaseorders'. May contain a version segment.",
      ),
    id: SAFE_ID.describe("The entity's ID — e.g. 'PN12345-01' for a part."),
    extendedProperties: z
      .string()
      .max(256)
      .regex(/^[A-Za-z0-9_,]*$/, "extendedProperties: alphanumeric + comma only")
      .optional()
      .describe("Optional endpoint-specific value to fetch related sub-objects in one call."),
  }),
  execute: async ({ area, resource, id, extendedProperties }) => {
    const decision = isEntityAllowed(area, resource, scopes, catalog);
    if (!decision.ok) return denyForEntity(decision);
    const query = extendedProperties
      ? `?extendedProperties=${encodeURIComponent(extendedProperties)}`
      : "";
    const path = `/proxy/entity/${encodeURIComponent(area)}/${resource
      .split("/")
      .map(encodeURIComponent)
      .join("/")}/${encodeURIComponent(id)}${query}`;
    const result = await callProxy("GET", path);
    return result;
  },
  });
}

// ---------------------------------------------------------------------------
// searchCatalog — semantic search over the parts catalog
//
// Backed by the Qdrant Cloud `olander-catalog` collection (1024d cosine).
// One vector per inv_mast_uid, embedded once with voyage-4-large during
// backfill. The Neon `catalog_item` table mirrors the row metadata + dedupe
// hash but the live vectors live in Qdrant — see docs/Vector_Store.md.
//
// The model picks this tool for descriptive part questions ("M10 stainless
// cap screw, ~50mm"), then chains into viewsQuery / entityGet for live
// stock/pricing/order history.

type SearchMatch = {
  item_id: string;
  item_desc: string | null;
  extended_desc: string | null;
  sales_pricing_unit: string | null;
  score: number;
};

type SearchError =
  | { error: "search_not_configured" }
  | { error: "search_failed"; detail: string };

// Exported so unit tests (searchCatalog-schema.test.ts) can exercise .parse()
// without depending on the factory's inferred return type — the AI SDK widens
// inputSchema to FlexibleSchema, which doesn't expose Zod's parse surface.
export const searchCatalogInputSchema = z.object({
  query: z
    .string()
    .min(2)
    .max(256)
    .describe(
      "Natural-language description of the part. The rep's own phrasing is fine — " +
        "don't translate to formal terminology.",
    ),
  topK: z.number().int().min(1).max(20).default(5),
});

function makeSearchCatalog(scopes: EffectiveScopes, catalog: ScopeCatalog) {
  return tool({
  description:
    "Semantic search over Olander's parts catalog (the inventory master). Use this " +
    "when the rep describes a part in their own words — e.g. \"M10 stainless cap " +
    "screw, around 50mm\" or \"anti-seize for high-temp fasteners\". Returns the " +
    "top-K candidate item_ids ranked by vector similarity. Follow up with viewsQuery " +
    "against p21_view_inv_loc on the returned item_ids for live on-hand stock, or " +
    "entityGet for the full record. DO NOT use this for exact-SKU lookups — use " +
    "entityGet({ area:'inventory', resource:'v2/parts', id:<sku> }) for those " +
    "(faster, authoritative). Returns { matches: [...] } with item_id, item_desc, " +
    "extended_desc, sales_pricing_unit, and a cosine-similarity score in [0,1].",
  inputSchema: searchCatalogInputSchema,
  execute: async ({
    query,
    topK,
  }): Promise<{ matches: SearchMatch[] } | SearchError | ScopeDenied> => {
    // The catalog index is sourced from p21_view_inv_mast — gate it on
    // whatever scope that view currently lives in so a member without that
    // scope can't bypass the viewsQuery check via the semantic-search path.
    const decision = isViewAllowed("p21_view_inv_mast", scopes, catalog);
    if (!decision.ok) return denyForView(decision);
    if (!process.env.VOYAGE_API_KEY || !qdrantConfigured()) {
      return { error: "search_not_configured" };
    }
    try {
      const vec = await embedQuery(query);
      // Filter delete_flag in Qdrant payload so soft-deleted SKUs never
      // surface. Qdrant cosine score is in [-1, 1]; voyage embeddings come
      // out normalized so the practical range is [0, 1] — pass through.
      const result = await searchCatalogByVector(vec, topK);
      const matches: SearchMatch[] = result.map((m) => {
        const p = m.payload;
        return {
          item_id: typeof p.item_id === "string" ? p.item_id : "",
          item_desc: typeof p.item_desc === "string" ? p.item_desc : null,
          extended_desc:
            typeof p.extended_desc === "string" ? p.extended_desc : null,
          sales_pricing_unit:
            typeof p.sales_pricing_unit === "string"
              ? p.sales_pricing_unit
              : null,
          score: m.score,
        };
      });
      return { matches };
    } catch (e) {
      return {
        error: "search_failed",
        detail: e instanceof Error ? e.message : String(e),
      };
    }
  },
  });
}

// Build the tool set for a single chat request. Pass the caller's effective
// scopes ("all" for admins) along with the ScopeCatalog snapshot loaded at
// request entry — every tool's execute path runs the scope check before any
// I/O, so a denied call costs no proxy / Qdrant / Voyage round-trip.
export function buildTools(scopes: EffectiveScopes, catalog: ScopeCatalog) {
  return {
    viewsQuery: makeViewsQuery(scopes, catalog),
    describeView: makeDescribeView(scopes, catalog),
    entityGet: makeEntityGet(scopes, catalog),
    searchCatalog: makeSearchCatalog(scopes, catalog),
  } as const;
}
