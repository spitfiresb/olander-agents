// Three serializers for tool-call result rows, used by the CSV/TSV/MD
// copy buttons on ToolCallCard (Stage 4c). All three follow the same
// shape: collect a stable header order, format each cell to a string,
// apply the format-specific escape rules, then join.
//
// Inputs are rows of arbitrary shape — P21's snake_case + JSON-parsed
// values arrive here unchanged, with the occasional nested object on
// extendedProperties expansions. The cell formatter coerces everything
// to a string deterministically so we never emit [object Object].

type Row = Record<string, unknown>;

// First-seen order across all rows. The first row's keys come first;
// any new key on a later row appends at the end. Stable + intuitive
// for tabular P21 results that share most columns but occasionally
// extend a few.
function collectHeaders(rows: Row[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        out.push(key);
      }
    }
  }
  return out;
}

// Coerce arbitrary cell values to a plain string. Strings passthrough;
// numbers/booleans go through String(); null/undefined become empty;
// Date becomes ISO; nested objects + arrays compact-JSON-stringify.
function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// RFC 4180 quoting: wrap cells containing comma, quote, CR, or LF in
// double quotes; double internal quotes to escape them.
function escapeCsvCell(s: string): string {
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Excel-friendly TSV: collapse tabs and newlines inside cells to a
// single space. No quoting — tabs in cells would break columns.
function escapeTsvCell(s: string): string {
  return s.replace(/[\t\r\n]+/g, " ");
}

// GFM table cell: escape pipes (which would break the column structure)
// and collapse newlines to spaces.
function escapeMdCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

export function toCsv(rows: Row[]): string {
  if (rows.length === 0) return "";
  const headers = collectHeaders(rows);
  const lines = [headers.map(escapeCsvCell).join(",")];
  for (const row of rows) {
    lines.push(
      headers.map((h) => escapeCsvCell(formatCell(row[h]))).join(","),
    );
  }
  return lines.join("\n");
}

export function toTsv(rows: Row[]): string {
  if (rows.length === 0) return "";
  const headers = collectHeaders(rows);
  const lines = [headers.map(escapeTsvCell).join("\t")];
  for (const row of rows) {
    lines.push(
      headers.map((h) => escapeTsvCell(formatCell(row[h]))).join("\t"),
    );
  }
  return lines.join("\n");
}

export function toMarkdown(rows: Row[]): string {
  if (rows.length === 0) return "";
  const headers = collectHeaders(rows);
  const lines = [
    `| ${headers.map(escapeMdCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) {
    lines.push(
      `| ${headers.map((h) => escapeMdCell(formatCell(row[h]))).join(" | ")} |`,
    );
  }
  return lines.join("\n");
}
