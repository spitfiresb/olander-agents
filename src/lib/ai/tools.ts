import { tool } from "ai";
import { z } from "zod";

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

const viewsQuery = tool({
  description:
    "Run a filtered, projected, sorted query against a P21 SQL view via the droplet proxy. " +
    "The primary tool for search-style questions: which parts, which customers, which orders. " +
    "View names MUST use the p21_view_* prefix — e.g. p21_view_inv_mast (parts), " +
    "p21_view_customer (customers), p21_view_oe_hdr (sales orders), p21_view_po_hdr (POs), " +
    "p21_view_inv_loc (on-hand by location), p21_view_vendor (vendors). " +
    "Filter uses OData v3 syntax: eq, ne, gt/ge, lt/le, and, or, not, " +
    "startswith(field,'X'), endswith(field,'X'), substringof('X', field). " +
    "Wrap string literals in single quotes. Use $select to project (views are 100+ columns; " +
    "always select only what you need). Returns { rows: [...], count }; rows are snake_case " +
    "with JSON booleans, numbers parsed from numeric strings, ISO date strings, and null for nulls.",
  inputSchema: z.object({
    viewName: z
      .string()
      .regex(/^p21_view_[a-z0-9_]+$/i, "must match p21_view_* (e.g. p21_view_inv_mast)"),
    filter: z
      .string()
      .optional()
      .describe(
        "OData $filter expression — e.g. \"startswith(item_id,'P26') and delete_flag eq 'N'\".",
      ),
    top: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Page size. Default 20. Cap 200 — never request more; LLMs don't benefit from huge result sets."),
    skip: z.number().int().min(0).optional(),
    select: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        "Comma-separated column list, or array of names. Project aggressively — views are wide.",
      ),
    orderBy: z
      .string()
      .optional()
      .describe('e.g. "item_id" or "date_created desc". Pair with skip/top for stable paging.'),
  }),
  execute: async (input) => {
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

const entityGet = tool({
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
    id: z.string().min(1).describe("The entity's ID — e.g. 'PN12345-01' for a part."),
    extendedProperties: z
      .string()
      .optional()
      .describe("Optional endpoint-specific value to fetch related sub-objects in one call."),
  }),
  execute: async ({ area, resource, id, extendedProperties }) => {
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

export const tools = { viewsQuery, entityGet } as const;
