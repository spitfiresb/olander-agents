// Field-level post-processing for P21 rows, applied in the app layer (tools.ts)
// after the droplet proxy returns. Two jobs:
//
//   1. Redaction — strip cost / margin columns for callers who lack the
//      `pricing` scope. The scope check in scopes.ts gates at *view* granularity,
//      but margin-bearing columns (moving_average_cost, gross_margin, sales_cost,
//      …) ride along on default-on views like p21_view_inv_loc / p21_view_oe_hdr.
//      This closes that leak at the column level so "margin is gated" is actually
//      true, not just documented.
//
//   2. Schema-aware numeric coercion — the proxy coerces numeric strings to
//      numbers by NAME regex (NUMERIC_FIELD_HINTS), which misses fields like
//      `gross_margin` and `profit_percent`. They arrive as strings ("34.500000")
//      and silently sort/compare lexically. Here we re-coerce by the bundled
//      schema's column *type* (Decimal / Int*), which is exact.
//
// Both are pure and unit-tested (see __tests__/p21-fields.test.ts) so the
// behavior is verifiable without a live proxy.

import { getViewSchema } from "@/lib/ai/p21-schema";

// The scope a caller must hold to see cost / margin data.
export const PRICING_SCOPE = "pricing";

// Columns that reveal what Olander PAYS or EARNS (cost basis, COGS, commission
// cost, gross margin, profit %, markup). Distinct from SELLING prices
// (price1..price10), which reps legitimately need to quote customers and which
// appear on customer-facing invoices anyway — those are NOT redacted here.
//
// Matched by name so it covers all 117 views uniformly, including the long tail.
// Validated against data/p21-schema.json: catches every cost-basis column
// (moving_average_cost, standard_cost, sales_cost, po_cost, other_cost,
// commission_cost, …), COGS, and ALL dollar-margin / profit columns —
// gross_margin, profit_percent, remote_margin (on ship_to), and the per-customer
// maximum_/minimum_order_profit thresholds — plus order_cost_basis and freight
// markups, while leaving account-number / code / flag / date columns (no dollar
// value), profit-CONTROL flags (enable_/override_/skip_/*_check/*_warning), and
// all selling prices (price1..price10, unit_price, extended_price) alone.
//
// Bare `margin`/`profit` are matched as whole segments (not just gross_margin /
// profit_percent) so columns like remote_margin and maximum_order_profit — which
// ride on default-on views (ship_to, customer) and previously leaked — are gated.
// Name-only matching errs toward over-redaction (e.g. cost_center, a GL code)
// rather than under-redaction: the safe-side bias for a confidentiality gate. If
// you touch either regex, re-run the schema audit test that asserts no Decimal
// value column matching cost/margin/profit slips through.
const SENSITIVE_NAME = /(^|_)(cost|cogs|margin|profit)(_|$)|markup/i;
const SENSITIVE_EXCLUDE =
  /(_uid|_id|_no|_acct|_cd|_flag|_option|_method)$|^use_|^post_|^suppress_|^enable_|^override_|^skip_|^oe_skip_|_edited$|_warning$|_limit$|_check$|_uncosted$|_unpriced$|date|account/i;

export function isSensitiveColumn(name: string): boolean {
  return SENSITIVE_NAME.test(name) && !SENSITIVE_EXCLUDE.test(name);
}

// True when the caller may see cost/margin. Admins ("all") always may.
export function callerHasPricing(scopes: "all" | string[]): boolean {
  return scopes === "all" || scopes.includes(PRICING_SCOPE);
}

type Row = Record<string, unknown>;

// Remove sensitive columns from a row set. Returns the cleaned rows plus the
// sorted, de-duped list of column names actually stripped (so the caller can
// tell the model to disclose the omission rather than imply the data is absent).
export function redactSensitiveRows(rows: Row[]): {
  rows: Row[];
  redactedColumns: string[];
} {
  const stripped = new Set<string>();
  const out = rows.map((row) => {
    const clean: Row = {};
    for (const [k, v] of Object.entries(row)) {
      if (isSensitiveColumn(k)) {
        stripped.add(k);
        continue;
      }
      clean[k] = v;
    }
    return clean;
  });
  return { rows: out, redactedColumns: [...stripped].sort() };
}

const NUMERIC_TYPES = new Set(["Decimal", "Int32", "Int16", "Byte"]);
const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;

// Coerce numeric-typed columns that arrived as strings into numbers, using the
// bundled schema's declared column type (exact, unlike the proxy's name regex).
// Only touches string values that are cleanly numeric and whose column the
// schema types as numeric — String-typed columns (even all-digit ones, e.g.
// invoice_hdr.customer_id) are left untouched so identities aren't mangled.
export function coerceRowsBySchema(viewName: string, rows: Row[]): Row[] {
  const view = getViewSchema(viewName);
  if (!view) return rows;
  const numericCols = new Set(
    view.columns.filter((c) => NUMERIC_TYPES.has(c.type)).map((c) => c.name),
  );
  if (numericCols.size === 0) return rows;
  return rows.map((row) => {
    let changed = false;
    const out: Row = {};
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === "string" && numericCols.has(k) && NUMERIC_STRING.test(v)) {
        const n = Number(v);
        if (Number.isFinite(n)) {
          out[k] = n;
          changed = true;
          continue;
        }
      }
      out[k] = v;
    }
    return changed ? out : row;
  });
}

// Tolerant numeric parse for aggregation folds. Accepts numbers, plain numeric
// strings, and strips thousands separators / surrounding whitespace. Returns
// null for anything non-numeric (null, "", "N", "PN12345-01") so the fold can
// skip it rather than poison the sum with NaN.
export function parseNumeric(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/,/g, "").trim();
  if (!NUMERIC_STRING.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
