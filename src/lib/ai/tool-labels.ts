// Centralized human-readable labels for tool calls.
//
// The model sees the wire-format tool names (`viewsQuery`, `entityGet`); reps
// shouldn't. Map them to verbs a rep would say out loud, scoped by which view
// or entity is being touched.

type ViewsQueryInput = {
  viewName?: string;
  filter?: string;
  select?: string | string[];
  top?: number;
};

type EntityGetInput = {
  area?: string;
  resource?: string;
  id?: string;
};

const VIEW_LABELS: Record<string, string> = {
  p21_view_inv_mast: "Inventory search",
  p21_view_inv_loc: "Stock-on-hand lookup",
  p21_view_customer: "Customer search",
  p21_view_vendor: "Vendor search",
  p21_view_oe_hdr: "Sales order search",
  p21_view_oe_line: "Order-line search",
  p21_view_po_hdr: "Purchase order search",
};

const ENTITY_LABELS: Record<string, string> = {
  "inventory/v2/parts": "Part detail",
  "inventory/parts": "Part detail",
  "entity/customers": "Customer detail",
  "sales/orders": "Sales order detail",
  "purchasing/purchaseorders": "Purchase order detail",
};

export function labelForToolPart(
  toolName: string,
  input: unknown,
): { label: string; sublabel?: string } {
  if (toolName === "viewsQuery") {
    const v = (input ?? {}) as ViewsQueryInput;
    const viewName = (v.viewName ?? "").toLowerCase();
    const base = VIEW_LABELS[viewName] ?? "P21 search";
    return { label: base, sublabel: humanizeFilter(v.filter) };
  }
  if (toolName === "entityGet") {
    const v = (input ?? {}) as EntityGetInput;
    const area = (v.area ?? "").toLowerCase();
    const resource = (v.resource ?? "").toLowerCase();
    const key = area && resource ? `${area}/${resource}` : "";
    const base = ENTITY_LABELS[key] ?? "Record lookup";
    return { label: base, sublabel: v.id ? `id ${v.id}` : undefined };
  }
  return { label: toolName };
}

// Convert OData $filter snippets into a plain-English summary when we can,
// otherwise return the verbatim filter (still readable, just dense).
//
// We deliberately only humanize a few obvious patterns — over-clever rewriting
// risks misleading a rep, and the raw filter is always available in "show
// details".
function humanizeFilter(filter: string | undefined): string | undefined {
  if (!filter) return undefined;
  const trimmed = filter.trim();
  if (trimmed.length === 0) return undefined;
  const startsWith = /startswith\(\s*[\w.]+\s*,\s*'([^']+)'\s*\)/i.exec(trimmed);
  if (startsWith && trimmed.length < 60) return `starting "${startsWith[1]}"`;
  const substring = /substringof\(\s*'([^']+)'/i.exec(trimmed);
  if (substring && trimmed.length < 60) return `matching "${substring[1]}"`;
  const eq = /(?:^|\s)([\w.]+)\s+eq\s+'?([^'\s]+)'?/i.exec(trimmed);
  if (eq && trimmed.length < 60) return `${eq[1]} = ${eq[2]}`;
  if (trimmed.length > 80) return `with filter`;
  return `with filter`;
}

export function summarizeToolUsageForCitation(
  toolName: string,
  input: unknown,
  output: unknown,
): string | null {
  if (toolName === "viewsQuery") {
    const v = (input ?? {}) as ViewsQueryInput;
    const view = v.viewName ?? "view";
    const rows = countRows(output);
    if (rows == null) return view;
    return `${view} (${rows} row${rows === 1 ? "" : "s"})`;
  }
  if (toolName === "entityGet") {
    const v = (input ?? {}) as EntityGetInput;
    const what = v.resource ?? v.area ?? "record";
    return `${what} (1 record)`;
  }
  return null;
}

function countRows(output: unknown): number | null {
  if (output && typeof output === "object" && "rows" in output) {
    const rows = (output as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows.length;
  }
  if (output && typeof output === "object" && "count" in output) {
    const c = (output as { count?: unknown }).count;
    if (typeof c === "number") return c;
  }
  return null;
}
