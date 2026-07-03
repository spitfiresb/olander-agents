import { tool } from "ai";
import { z } from "zod";
import { embedQuery } from "@/lib/ai/embeddings";
import { getViewSchema } from "@/lib/ai/p21-schema";
import { qdrantConfigured, searchCatalogByVector } from "@/lib/ai/qdrant";
import { docsConfigured } from "@/lib/ai/qdrant-docs";
import { searchReferenceDocuments, type DocumentPassage } from "@/lib/documents";
import {
  isEntityAllowed,
  isViewAllowed,
  type EffectiveScopes,
  type ScopeCatalog,
} from "@/lib/scopes";
import {
  callerHasPricing,
  coerceRowsBySchema,
  isSensitiveColumn,
  nullifySentinelDates,
  nullifySentinelDatesLoose,
  PRICING_SCOPE,
  redactSensitiveRows,
} from "@/lib/ai/p21-fields";

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

// Turn an upstream/proxy error into something the model can act on instead of
// blindly retrying. The #1 loop we've seen: P21 (OData v3) rejects a bad filter
// with a cryptic "Syntax error at position N", the model repeats the IDENTICAL
// call, and burns the whole step budget without ever answering. Attaching a
// concrete hint + an explicit "don't retry unchanged" lets the model
// self-correct (and pairs with the route's final-step synthesis safety net).
// See TESTING.md § P21 for the date-literal gotcha this most often catches.
function annotateViewError(result: unknown): unknown {
  if (!result || typeof result !== "object" || !("error" in result)) return result;
  const blob = JSON.stringify(result);
  let hint =
    "This query was rejected. Revise it before trying again — do NOT repeat the same call " +
    "unchanged. Use describeView to confirm the view's column names and types.";
  if (/syntax error/i.test(blob)) {
    hint =
      "OData v3 syntax error in the filter. Most common cause: a bare date — dates MUST be typed " +
      "literals like datetime'2026-06-17T00:00:00', never a bare 2026-06-17. Also check that " +
      "string values are single-quoted and every column name exists (describeView). Fix the " +
      "filter; do NOT retry it unchanged.";
  }
  return { ...(result as Record<string, unknown>), hint };
}

// A substringof() text filter on item_desc that comes back with ZERO rows is
// the classic false-negative: P21's descriptions are abbreviated and
// inconsistent ('LOCKNUT' not 'LOCK NUT', 'SST'/'316SST' not 'STAINLESS'), so a
// literal text match routinely misses parts we actually stock. This fires on the
// SYMPTOM (a descriptive filter that whiffed) regardless of the specific part,
// so it catches the whole class the system prompt's steering can miss — it steers
// the model to searchCatalog (semantic, spelling-immune) instead of letting an
// empty page become a confident "we don't carry it". See TESTING.md § P21
// (descriptive-query routing) and the "Finding parts by description" prompt block.
const DESC_TEXT_FILTER_RE = /substringof\s*\([^)]*\bitem_desc\b/i;

export function descriptiveNoMatchHint(
  filter: string | undefined,
  rowCount: number,
): string | null {
  if (rowCount !== 0 || !filter || !DESC_TEXT_FILTER_RE.test(filter)) return null;
  return (
    "0 rows from a substringof() text filter on item_desc. P21 descriptions are " +
    "abbreviated and inconsistent ('LOCKNUT' not 'LOCK NUT', 'SST'/'316SST' not " +
    "'STAINLESS'), so a literal text match routinely misses parts we actually " +
    "stock. Do NOT conclude 'no results' from this empty page — retry the lookup " +
    "with searchCatalog (semantic search over the catalog, immune to these " +
    "abbreviation differences), then read p21_view_inv_loc on the item_ids it " +
    "returns for on-hand."
  );
}

// Post-process a successful viewsQuery page from the proxy before it reaches
// the model:
//   - coerce numeric columns the proxy's name-regex missed (by schema type),
//     so fields like gross_margin/profit_percent sort and compare numerically;
//   - redact cost/margin columns for callers without the pricing scope;
//   - flag truncation so a full page is never presented as a complete list or
//     an exact count;
//   - on an empty page from a text filter on item_desc, steer to searchCatalog.
// Errors fall through to annotateViewError unchanged.
function finalizeViewResult(
  viewName: string,
  result: unknown,
  requestedTop: number,
  scopes: EffectiveScopes,
  filter?: string,
): unknown {
  if (!result || typeof result !== "object" || "error" in result) {
    return annotateViewError(result);
  }
  const obj = result as {
    rows?: unknown;
    payload_truncated?: boolean;
    original_row_count?: number;
  };
  if (!Array.isArray(obj.rows)) return result;

  let rows = coerceRowsBySchema(viewName, obj.rows as Record<string, unknown>[]);
  // Null P21's "never" date sentinels (e.g. last_sale_date = 1990-01-01) so the
  // model reads them as "never", not a real ~36-year-old date. Must run before
  // the model sees the rows — this is the fix for the dead-stock list that
  // surfaced stocked items and aged them from a placeholder. See p21-fields.ts.
  rows = nullifySentinelDates(viewName, rows);
  let redactedColumns: string[] = [];
  if (!callerHasPricing(scopes)) {
    const red = redactSensitiveRows(rows);
    rows = red.rows;
    redactedColumns = red.redactedColumns;
  }

  const out: Record<string, unknown> = { rows, count: rows.length };
  if (rows.length >= requestedTop) {
    out.more_available = true;
    out.note_truncation =
      `Returned ${rows.length} rows — the page limit. More rows probably match. Do NOT present ` +
      `this as a complete list or an exact count; say "at least N", or page with skip, or use the ` +
      `aggregate tool for a real total/count.`;
  }
  if (obj.payload_truncated) {
    out.payload_truncated = true;
    out.original_row_count = obj.original_row_count;
  }
  if (redactedColumns.length) {
    out.redacted_columns = redactedColumns;
    out.note_redaction =
      `Cost/margin columns (${redactedColumns.join(", ")}) were withheld — you lack the "Job ` +
      `pricing" data scope. Do NOT say the system has no such data; tell the user it requires ` +
      `pricing access that an admin can grant.`;
  }
  if (rows.length === 0) {
    const noMatchHint = descriptiveNoMatchHint(filter, 0);
    if (noMatchHint) out.note_no_match = noMatchHint;
  }
  return out;
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
    const requestedTop = input.top ?? 20;
    const result = await callProxy("POST", `/proxy/views/${encodeURIComponent(input.viewName)}`, {
      filter: input.filter,
      top: requestedTop,
      skip: input.skip,
      select: input.select,
      orderBy: input.orderBy,
    });
    return finalizeViewResult(input.viewName, result, requestedTop, scopes, input.filter);
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
    if (!result || typeof result !== "object" || "error" in result) return result;
    // Null P21 "never" date sentinels (e.g. last_sale_date = 1990-01-01) on the
    // single record too — same fix as viewsQuery, name-gated since an entity
    // route has no p21_view_* column schema to consult.
    let record = nullifySentinelDatesLoose(result as Record<string, unknown>);
    // Redact cost/margin fields on the single record for callers without the
    // pricing scope (the parts entity carries cost alongside selling prices).
    if (!callerHasPricing(scopes)) {
      const { rows, redactedColumns } = redactSensitiveRows([record]);
      record = rows[0] as Record<string, unknown>;
      if (redactedColumns.length) record.redacted_columns = redactedColumns;
    }
    return record;
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

// ---------------------------------------------------------------------------
// aggregate — server-side SUM / COUNT / AVG / MIN / MAX (+ optional GROUP BY)
//
// P21's OData tier exposes no $apply / $count, so a single viewsQuery can never
// answer "total sales this month", "how many open orders", "biggest order by
// line value", or "top customers by spend" — the model would otherwise eyeball
// a ≤50-row page and emit a confident wrong number (the CEO's $20k "largest
// order"). This tool pages through the view via the proxy and folds the rows in
// the app layer. It is bounded (a fixed page/time budget); when it can't scan
// the whole population it returns complete:false and the model must disclose the
// result is a lower bound, not an exact figure.
// ---------------------------------------------------------------------------

const SAFE_COLUMN = z
  .string()
  .regex(/^[a-z0-9_]+$/i, "column must be a bare column name");

function makeAggregate(scopes: EffectiveScopes, catalog: ScopeCatalog) {
  return tool({
    description:
      "Compute a real SUM / COUNT / AVG / MIN / MAX over a P21 view, optionally " +
      "grouped — the correct way to answer total / count / average / ranking " +
      "questions. Runs server-side on the droplet next to P21: COUNT is EXACT " +
      "via $inlinecount (no scan), MIN/MAX EXACT via orderby+top (no scan), and " +
      "SUM/AVG/grouped fold big pages in one hop. Use it for: 'how many open " +
      "orders' (op:count on p21_view_oe_hdr), 'total sales this month' (op:sum, " +
      "column:total_amount on p21_view_invoice_hdr + a date filter), 'biggest " +
      "order by line value' (op:sum, column:extended_price, groupBy:order_no on " +
      "p21_view_oe_line, top:1), 'top customers by spend' (op:sum, " +
      "column:total_amount, groupBy:customer_id on p21_view_invoice_hdr). Returns " +
      "{ op, value | groups:[{key,value,n}], total_count, rows_scanned, complete }. " +
      "complete:true means the figure is EXACT — state it plainly, no hedging. " +
      "complete:false means the scan hit its budget and covers rows_scanned of " +
      "total_count — report it as a sample of that size and offer a tighter " +
      "filter; never present it as exact. Grouped results rank by the aggregate " +
      "(order:'desc' default); pass order:'asc' for the BOTTOM groups and `having` " +
      "to keep only groups meeting a threshold (e.g. dead stock = max qty_on_hand " +
      "le 0) — those are the zero/bottom questions a plain ranking can't answer. " +
      "Big views (inv_loc is 260k rows) only fold COMPLETE when you filter first: " +
      "a filter that shrinks the scan (e.g. qty_on_hand gt 0) is the difference " +
      "between complete:true and a partial scan. Cost/margin columns need the pricing scope.",
    inputSchema: z.object({
      viewName: z
        .string()
        .regex(/^p21_view_[a-z0-9_]+$/i, "must match p21_view_* (e.g. p21_view_invoice_hdr)"),
      op: z.enum(["sum", "count", "avg", "min", "max"]),
      column: SAFE_COLUMN.optional().describe(
        "Numeric column to aggregate. Required for sum/avg/min/max; ignored for count.",
      ),
      filter: SAFE_FILTER.optional().describe(
        "OData $filter to scope the population — e.g. a date range for 'this month'. " +
          "Same syntax as viewsQuery; datetime'…' literals for dates.",
      ),
      groupBy: SAFE_COLUMN.optional().describe(
        "Optional column to group by; returns the top groups ranked by the aggregate.",
      ),
      order: z
        .enum(["asc", "desc"])
        .optional()
        .describe(
          "Rank direction for grouped results. Default 'desc' (biggest first). Use 'asc' " +
            "for the SMALLEST/BOTTOM groups — slowest movers, least stock, etc.",
        ),
      having: z
        .object({
          op: z.enum(["eq", "ne", "gt", "ge", "lt", "le"]),
          value: z.number(),
        })
        .optional()
        .describe(
          "Keep only groups whose aggregate value meets this predicate — the way to ask " +
            "for ZEROS/BOTTOMS a top-N ranking can't express. E.g. dead stock = " +
            "{op:'max',column:'qty_on_hand',groupBy:'item_id',having:{op:'le',value:0}}. " +
            "Returns groups_matching = how many groups qualified (exact when complete). " +
            "For summed decimals prefer le/ge thresholds over eq (float equality).",
        ),
      top: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("For grouped results: how many top groups to return. Default 10."),
    }),
    execute: async (input) => {
      const decision = isViewAllowed(input.viewName, scopes, catalog);
      if (!decision.ok) return denyForView(decision);
      if (input.op !== "count" && !input.column) {
        return {
          error: "bad_request" as const,
          detail: `op "${input.op}" needs a numeric column. Pass column, or use op:count.`,
        };
      }
      // Don't let aggregation read around the column-level redaction: summing a
      // cost/margin column still requires the pricing scope.
      if (!callerHasPricing(scopes)) {
        const sensitive = [input.column, input.groupBy]
          .filter((c): c is string => Boolean(c))
          .find((c) => isSensitiveColumn(c));
        if (sensitive) {
          return {
            error: "scope_denied" as const,
            resource: `${input.viewName}.${sensitive}`,
            scope_required: PRICING_SCOPE,
            scope_label: catalog.scopes.get(PRICING_SCOPE)?.label ?? "Job pricing",
            detail:
              "This aggregation references cost/margin data your access doesn't include. " +
              "Tell the user it needs pricing access; don't claim the data is absent.",
          };
        }
      }

      // The fold runs on the droplet (one hop from P21), not here. We hand off
      // op/column/filter/groupBy plus a STABLE sort key — the view's key (UID)
      // column — which the proxy needs for safe $skip paging (docs §Pagination).
      // COUNT comes back exact via $inlinecount and MIN/MAX exact via
      // orderby+top, with no scan at all; SUM/AVG/grouped are folded over big
      // pages and return total_count so coverage is exact, not guessed.
      const view = getViewSchema(input.viewName);
      const keyCol =
        view?.columns.find((c) => c.key)?.name ?? view?.columns[0]?.name;

      const res = await callProxy(
        "POST",
        `/proxy/aggregate/${encodeURIComponent(input.viewName)}`,
        {
          op: input.op,
          column: input.column,
          filter: input.filter,
          groupBy: input.groupBy,
          orderBy: keyCol,
          top: input.top,
          order: input.order,
          having: input.having,
        },
      );
      if (!res || typeof res !== "object" || "error" in res) {
        return annotateViewError(res);
      }

      const out = res as Record<string, unknown> & {
        complete?: boolean;
        rows_scanned?: number;
        total_count?: number | null;
      };
      // Honest coverage: $inlinecount gives the exact population, so a partial
      // scan reports "X of Y", never a vague "lower bound of unknown size".
      if (out.complete === false) {
        const scanned = typeof out.rows_scanned === "number" ? out.rows_scanned : 0;
        const total = typeof out.total_count === "number" ? out.total_count : null;
        const pct = total ? ` (~${Math.round((scanned / total) * 100)}%)` : "";
        out.note =
          `Partial — scanned ${scanned.toLocaleString()}${total ? ` of ${total.toLocaleString()}` : ""} rows${pct} ` +
          `before the scan budget. Treat the value as a LOWER BOUND and any ranking as approximate; tell the ` +
          `user it's based on a sample of that size and offer a tighter filter (e.g. a narrower date range) for ` +
          `an exact figure.`;
      }
      return out;
    },
  });
}

// ---------------------------------------------------------------------------
// searchDocuments — semantic search over admin-uploaded reference documents
//
// Backed by the Qdrant `olander-docs` collection (1024d cosine), one point per
// text chunk (src/lib/documents.ts). Unlike the P21 tools this is NOT scope-
// gated: the documents are company reference material an admin deliberately
// published, so any signed-in rep may search them. (Per-document scoping is a
// possible future refinement — see the docs-store plan.)

type DocSearchError =
  | { error: "search_not_configured" }
  | { error: "search_failed"; detail: string };

function makeSearchDocuments() {
  return tool({
    description:
      "Semantic search over Olander's internal reference documents — policies, " +
      "manuals, employee handbook, quality/ISO procedures, product catalogs, and " +
      "guides that an admin has uploaded. Use this when the rep asks about company " +
      "policy, procedures, specifications, or anything that lives in a document " +
      "rather than the P21 ERP (e.g. \"what's our return policy\", \"torque spec " +
      "for a Helicoil M10 insert\", \"PTO accrual rules\"). Returns { passages: " +
      "[{ source, text, score }] } — cite the source filename in your answer. For " +
      "live parts/stock/order data use viewsQuery, searchCatalog, or aggregate instead.",
    inputSchema: z.object({
      query: z
        .string()
        .min(2)
        .max(512)
        .describe("Natural-language question. The rep's own phrasing is fine."),
      topK: z.number().int().min(1).max(10).default(5),
    }),
    execute: async ({
      query,
      topK,
    }): Promise<{ passages: DocumentPassage[] } | DocSearchError> => {
      if (!process.env.VOYAGE_API_KEY || !docsConfigured()) {
        return { error: "search_not_configured" };
      }
      try {
        const passages = await searchReferenceDocuments(query, topK);
        return { passages };
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
    aggregate: makeAggregate(scopes, catalog),
    searchDocuments: makeSearchDocuments(),
  } as const;
}
