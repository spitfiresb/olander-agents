"use client";

import { useMemo } from "react";

type ColumnFormat = "currency" | "int" | "date" | "id" | "text";

export type Column = {
  key: string;
  label: string;
  align?: "left" | "right";
  format?: ColumnFormat;
};

type Props = {
  columns: Column[];
  rows: Record<string, unknown>[];
  maxRows?: number;
};

const DESC_TRUNCATE = 80;

export function ResultsTable({ columns, rows, maxRows }: Props) {
  const visibleRows = useMemo(
    () => (maxRows ? rows.slice(0, maxRows) : rows),
    [rows, maxRows],
  );

  if (visibleRows.length === 0) {
    return (
      <div className="rounded-2xl border border-brand-charcoal/10 bg-white px-4 py-3 text-sm text-brand-ink-soft">
        No rows.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-brand-charcoal/10 bg-white">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 bg-brand-canvas/70 text-left text-xs uppercase tracking-wider text-brand-ink-soft">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={`px-3 py-2 font-semibold ${
                    c.align === "right" ? "text-right" : "text-left"
                  }`}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, ri) => (
              <tr
                key={ri}
                className={
                  ri % 2 === 0
                    ? "bg-white"
                    : "bg-brand-canvas/40"
                }
              >
                {columns.map((c) => (
                  <Cell key={c.key} column={c} value={row[c.key]} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {maxRows && rows.length > maxRows && (
        <div className="border-t border-brand-charcoal/10 bg-brand-canvas/40 px-3 py-1.5 text-[11px] text-brand-ink-soft">
          Showing {maxRows} of {rows.length} rows.
        </div>
      )}
    </div>
  );
}

function Cell({ column, value }: { column: Column; value: unknown }) {
  const fmt = column.format ?? inferFormat(column.key);
  const display = formatValue(value, fmt);
  const isMono = fmt === "id";
  const isRight = column.align === "right" || isNumericFormat(fmt);
  const isLong =
    typeof display === "string" && display.length > DESC_TRUNCATE;
  const shown = isLong ? display.slice(0, DESC_TRUNCATE) + "…" : display;

  return (
    <td
      className={`px-3 py-2 align-top text-brand-charcoal ${
        isRight ? "text-right tabular-nums" : "text-left"
      } ${isMono ? "font-mono text-[13px]" : ""}`}
      title={isLong ? display : undefined}
    >
      {shown}
    </td>
  );
}

function isNumericFormat(fmt: ColumnFormat): boolean {
  return fmt === "currency" || fmt === "int";
}

// Best-effort inference so model-emitted markdown tables format sensibly
// without per-prompt tuning.
export function inferFormat(key: string): ColumnFormat {
  const k = key.toLowerCase();
  if (/(price|cost|amount|total)/.test(k)) return "currency";
  if (/(qty|quantity|count|stock|on_hand|on-hand|onhand)/.test(k)) return "int";
  if (/(date|created|updated)/.test(k)) return "date";
  if (/(_id|^id$|item|customer|order|sku|part|inv_mast_uid)/.test(k)) return "id";
  return "text";
}

function formatValue(value: unknown, fmt: ColumnFormat): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (fmt) {
    case "currency": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) return String(value);
      return n.toLocaleString(undefined, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }
    case "int": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) return String(value);
      return Math.round(n).toLocaleString();
    }
    case "date": {
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
        return value.slice(0, 10);
      }
      return String(value);
    }
    case "id":
    case "text":
    default:
      return String(value);
  }
}
