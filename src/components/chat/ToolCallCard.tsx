"use client";

import { useState, useMemo } from "react";
import { labelForToolPart } from "@/lib/ai/tool-labels";
import { toCsv, toMarkdown, toTsv } from "@/lib/tool-result-format";
import { ResultsTable, type Column, inferFormat } from "./ResultsTable";

export type ToolPartLike = {
  type: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  toolCallId?: string;
};

const TOOL_TYPE_PREFIX = "tool-";

export function isToolPart(part: { type: string }): part is { type: string } & ToolPartLike {
  return typeof part.type === "string" && part.type.startsWith(TOOL_TYPE_PREFIX);
}

function toolNameOf(part: ToolPartLike): string {
  return part.type.slice(TOOL_TYPE_PREFIX.length);
}

export function ToolCallCard({ part }: { part: ToolPartLike }) {
  const [expanded, setExpanded] = useState(false);
  const toolName = toolNameOf(part);
  const { label, sublabel } = labelForToolPart(toolName, part.input);

  const state =
    part.state === "output-available"
      ? "success"
      : part.state === "output-error"
        ? "error"
        : "pending";

  const symbolicError = symbolicErrorLabel(part.output, part.errorText);
  const rows = extractRows(part.output);
  const rowCount = rows?.length ?? (countOf(part.output) ?? undefined);
  const filterText = (part.input as { filter?: string } | undefined)?.filter;

  return (
    // animate-message-in: OpenAI models emit tool calls in parallel bursts
    // (Anthropic paced them one per step), so several cards can mount in the
    // same render. The mount animation keeps that a fade-up instead of a hard
    // pop-in; reduced-motion users get an instant render via the media query.
    <div className="animate-message-in overflow-hidden rounded-2xl border border-brand-charcoal/10 bg-white">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-brand-canvas/60 focus-visible:bg-brand-canvas/60 focus-visible:outline-none"
        aria-expanded={expanded}
      >
        <StatusGlyph state={state} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-medium text-brand-charcoal">{label}</span>
            {sublabel && (
              <span className="truncate text-xs text-brand-ink-soft">
                {sublabel}
              </span>
            )}
          </div>
          <div className="text-[11px] uppercase tracking-wider text-brand-ink-soft">
            {state === "pending" && "Searching…"}
            {state === "success" &&
              (rowCount != null
                ? `Found ${rowCount} row${rowCount === 1 ? "" : "s"}`
                : "Done")}
            {state === "error" && (symbolicError ?? "Lookup failed")}
          </div>
        </div>
        <ChevronIcon expanded={expanded} />
      </button>

      {expanded && (
        <div className="border-t border-brand-charcoal/10 bg-brand-canvas/30 px-3 py-3">
          <DetailGrid
            toolName={toolName}
            input={part.input}
            filter={filterText}
          />
          {rows && rows.length > 0 && (
            <div className="mt-3">
              {state === "success" && <CopyRow rows={rows} />}
              <DetailTable rows={rows} />
            </div>
          )}
          {state === "error" && (
            <div className="mt-3 text-xs text-brand-ink-soft">
              {symbolicError ?? "Upstream lookup did not return data."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DetailGrid({
  toolName,
  input,
  filter,
}: {
  toolName: string;
  input: unknown;
  filter?: string;
}) {
  const i = (input ?? {}) as {
    viewName?: string;
    area?: string;
    resource?: string;
    id?: string;
    top?: number;
    skip?: number;
    select?: string | string[];
    query?: string;
    topK?: number;
    op?: string;
    column?: string;
    groupBy?: string;
  };

  const rows: Array<[string, string]> = [];
  if (toolName === "viewsQuery") {
    if (i.viewName) rows.push(["View", i.viewName]);
    if (filter) rows.push(["Filter", filter]);
    if (i.select) {
      const cols = Array.isArray(i.select) ? i.select.join(", ") : i.select;
      rows.push(["Columns", cols]);
    }
    if (i.top != null) rows.push(["Top", String(i.top)]);
    if (i.skip != null) rows.push(["Skip", String(i.skip)]);
  } else if (toolName === "entityGet") {
    if (i.area) rows.push(["Area", i.area]);
    if (i.resource) rows.push(["Resource", i.resource]);
    if (i.id) rows.push(["ID", i.id]);
  } else if (toolName === "searchCatalog") {
    if (i.query) rows.push(["Query", i.query]);
    if (i.topK != null) rows.push(["Top K", String(i.topK)]);
  } else if (toolName === "aggregate") {
    if (i.op) rows.push(["Operation", i.op]);
    if (i.viewName) rows.push(["View", i.viewName]);
    if (i.column) rows.push(["Column", i.column]);
    if (i.groupBy) rows.push(["Group by", i.groupBy]);
    if (filter) rows.push(["Filter", filter]);
  } else {
    try {
      rows.push(["Input", JSON.stringify(input)]);
    } catch {
      // ignore
    }
  }

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-medium text-brand-ink-soft">{k}</dt>
          <dd className="break-words font-mono text-brand-charcoal">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function DetailTable({ rows }: { rows: Record<string, unknown>[] }) {
  const columns = useMemo<Column[]>(() => {
    const first = rows[0];
    if (!first) return [];
    return Object.keys(first).map((key) => ({
      key,
      label: key,
      format: inferFormat(key),
      align: ["currency", "int"].includes(inferFormat(key)) ? "right" : "left",
    }));
  }, [rows]);

  return <ResultsTable columns={columns} rows={rows} maxRows={5} />;
}

function StatusGlyph({ state }: { state: "pending" | "success" | "error" }) {
  if (state === "pending") {
    return (
      <span
        aria-label="Searching"
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center"
      >
        <span className="block h-3 w-3 animate-spin rounded-full border-2 border-brand-ink-soft/30 border-t-brand-charcoal" />
      </span>
    );
  }
  if (state === "success") {
    return (
      <span
        aria-label="Done"
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600/10 text-emerald-700"
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 8.5L6.5 12L13 4.5" />
        </svg>
      </span>
    );
  }
  return (
    <span
      aria-label="Error"
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-red/10 text-brand-red"
    >
      <span className="block h-1.5 w-1.5 rounded-full bg-brand-red" />
    </span>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`text-brand-ink-soft transition-transform ${
        expanded ? "rotate-180" : ""
      }`}
      aria-hidden
    >
      <path d="M3 6l5 5 5-5" />
    </svg>
  );
}

function countOf(output: unknown): number | null {
  if (output && typeof output === "object" && "count" in output) {
    const c = (output as { count?: unknown }).count;
    if (typeof c === "number") return c;
  }
  return null;
}

function extractRows(output: unknown): Record<string, unknown>[] | null {
  if (!output || typeof output !== "object") return null;
  // Error envelope from the proxy or search path — never treat as data,
  // regardless of any other keys that might be present alongside.
  if ("error" in output) return null;

  if ("rows" in output) {
    const r = (output as { rows?: unknown }).rows;
    if (Array.isArray(r)) {
      return r.filter(
        (row): row is Record<string, unknown> =>
          typeof row === "object" && row !== null,
      );
    }
  }
  // searchCatalog returns { matches: [...] } rather than { rows }. Surface
  // the candidate list in the same expandable table the other tools use.
  if ("matches" in output) {
    const m = (output as { matches?: unknown }).matches;
    if (Array.isArray(m)) {
      return m.filter(
        (row): row is Record<string, unknown> =>
          typeof row === "object" && row !== null,
      );
    }
  }
  // entityGet returns a single record — no `rows`/`matches` wrapper. Wrap
  // it in a 1-row array so the same downstream code path (DetailTable +
  // copy buttons) works for it. Side benefit: entityGet results now
  // render in the expanded card's table where they didn't before 4c.
  if (!Array.isArray(output) && Object.keys(output as object).length > 0) {
    return [output as Record<string, unknown>];
  }
  return null;
}

// Stage 4c — right-aligned pill row above the result table. Three small
// buttons (CSV / TSV / MD) → one click copies the result in that format
// to the rep's clipboard. Brief "Copied" state for 1.5s, then revert.
// Only renders when the parent already gated on rows.length > 0 AND
// state === "success" (so error/pending paths can't surface a button
// that would copy stale or empty content).
function CopyRow({ rows }: { rows: Record<string, unknown>[] }) {
  return (
    <div className="mb-2 flex justify-end gap-1.5">
      <CopyButton label="CSV" build={() => toCsv(rows)} />
      <CopyButton label="TSV" build={() => toTsv(rows)} />
      <CopyButton label="MD" build={() => toMarkdown(rows)} />
    </div>
  );
}

function CopyButton({
  label,
  build,
}: {
  label: string;
  build: () => string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(build());
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          // Modern browsers grant clipboard write on user gesture; the
          // rare failure path doesn't warrant any UI signal.
        }
      }}
      aria-label={`Copy as ${label}`}
      className="min-w-[3.5rem] rounded-full border border-brand-charcoal/15 bg-white px-2.5 py-0.5 text-xs text-brand-charcoal transition-colors hover:border-brand-charcoal/30 hover:bg-brand-sand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas"
    >
      {copied ? "Copied" : label}
    </button>
  );
}

// Output may carry a proxy error envelope; surface only the symbolic code,
// never the raw body (which can contain internal IPs / hostnames).
function symbolicErrorLabel(
  output: unknown,
  errorText: string | undefined,
): string | null {
  if (output && typeof output === "object" && "error" in output) {
    const e = (output as { error?: unknown }).error;
    if (typeof e === "string") return errorCodeToLabel(e);
  }
  if (errorText) return "Lookup failed";
  return null;
}

function errorCodeToLabel(code: string): string {
  switch (code) {
    case "proxy_not_configured":
      return "P21 integration not configured";
    case "proxy_unreachable":
      return "P21 proxy unreachable";
    case "proxy_status":
      return "P21 returned an error";
    case "credentials_pending":
      return "P21 credentials not provisioned";
    case "upstream_timeout":
      return "P21 upstream timed out";
    case "bad_view_name":
      return "Unsupported P21 view";
    case "search_not_configured":
      return "Catalog search not configured";
    case "search_failed":
      return "Catalog search failed";
    default:
      return "Lookup failed";
  }
}
