"use client";

import { useMemo, useState } from "react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ResultsTable, inferFormat, type Column } from "./ResultsTable";

// Curated Markdown renderer for assistant output.
//
// Discipline:
//   - GFM only (tables, task lists, strikethrough, autolinks)
//   - No raw HTML (`rehype-raw` deliberately omitted)
//   - No images — the model has no need to emit them
//   - Links forced to `target="_blank" rel="noreferrer noopener"`
//   - Tables route through <ResultsTable> for consistent formatting

type Props = { text: string };

export function AssistantContent({ text }: Props) {
  const components = useMemo<Components>(() => makeComponents(), []);

  return (
    <div className="prose-chat min-w-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={components}
        urlTransform={safeUrlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function safeUrlTransform(url: string): string {
  const lower = url.trim().toLowerCase();
  if (
    lower.startsWith("http:") ||
    lower.startsWith("https:") ||
    lower.startsWith("mailto:") ||
    lower.startsWith("/")
  ) {
    return url;
  }
  return "";
}

function makeComponents(): Components {
  return {
    p: ({ children }) => (
      <p className="my-2 leading-relaxed text-brand-charcoal first:mt-0 last:mb-0">
        {children}
      </p>
    ),
    h2: ({ children }) => (
      <h2 className="mb-2 mt-4 text-base font-semibold text-brand-charcoal first:mt-0">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="mb-1.5 mt-3 text-sm font-semibold text-brand-charcoal first:mt-0">
        {children}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 className="mb-1.5 mt-3 text-sm font-semibold text-brand-charcoal first:mt-0">
        {children}
      </h4>
    ),
    ul: ({ children }) => (
      <ul className="my-2 ml-5 list-disc space-y-1 marker:text-brand-charcoal/30">
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="my-2 ml-5 list-decimal space-y-1 marker:text-brand-charcoal/40">
        {children}
      </ol>
    ),
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    strong: ({ children }) => (
      <strong className="font-semibold text-brand-charcoal">{children}</strong>
    ),
    em: ({ children }) => <em className="italic">{children}</em>,
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="text-brand-red underline underline-offset-2 hover:opacity-90"
      >
        {children}
      </a>
    ),
    blockquote: ({ children }) => (
      <blockquote className="my-3 border-l-2 border-brand-charcoal/15 pl-3 text-brand-ink-soft">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="my-4 border-brand-charcoal/10" />,
    code: ({ className, children, ...rest }) => {
      const isInline = !(rest as { node?: { position?: unknown } }).node;
      if (isInline || !className) {
        return (
          <code className="rounded-sm bg-brand-sand/40 px-1 py-0.5 font-mono text-[0.85em] text-brand-charcoal">
            {children}
          </code>
        );
      }
      return <code className={className}>{children}</code>;
    },
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    table: ({ children }) => parseAndRenderTable(children),
    // No-op the granular table tags — parseAndRenderTable owns the output.
    // react-markdown still walks the tree, but our route catches at <table>.
    img: () => null,
    iframe: () => null,
    script: () => null,
  };
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = extractText(children);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be blocked; fail silently
    }
  };

  return (
    <div className="group relative my-3 overflow-hidden rounded-2xl bg-brand-charcoal text-white/90">
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy code"}
        className="absolute right-2 top-2 z-10 inline-flex h-7 items-center gap-1 rounded-full border border-white/15 bg-white/10 px-2.5 text-[11px] font-medium text-white opacity-0 transition-opacity hover:bg-white/20 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 group-hover:opacity-100"
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed">
        {children}
      </pre>
    </div>
  );
}

function extractText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (
    children &&
    typeof children === "object" &&
    "props" in children &&
    (children as ReactElement<{ children?: ReactNode }>).props.children !==
      undefined
  ) {
    return extractText(
      (children as ReactElement<{ children?: ReactNode }>).props.children,
    );
  }
  return "";
}

type RowChild = ReactElement<{ children?: ReactNode }>;

// react-markdown hands us a tree of <thead>/<tbody>/<tr>/<th>/<td> elements.
// We rebuild it as a clean {columns, rows} pair so the model's tables look
// identical to tool-result preview tables and benefit from numeric alignment.
function parseAndRenderTable(children: ReactNode): ReactElement {
  const { headers, dataRows } = collectTableRows(children);
  if (headers.length === 0 || dataRows.length === 0) {
    return (
      <table className="my-3 w-full border-collapse text-sm">{children}</table>
    );
  }
  const columns: Column[] = headers.map((label) => {
    const key = label || `col-${Math.random()}`;
    const fmt = inferFormat(label);
    return {
      key,
      label,
      format: fmt,
      align: ["currency", "int"].includes(fmt) ? "right" : "left",
    };
  });
  const rows = dataRows.map((cells) => {
    const row: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      row[col.key] = cells[i] ?? "";
    });
    return row;
  });
  return (
    <div className="my-3">
      <ResultsTable columns={columns} rows={rows} />
    </div>
  );
}

function collectTableRows(children: ReactNode): {
  headers: string[];
  dataRows: string[][];
} {
  const all = flatten(children);
  let headers: string[] = [];
  const dataRows: string[][] = [];

  for (const node of all) {
    if (!isElement(node)) continue;
    const tag = (node.type as { name?: string } | string) === "thead" ? "thead" : typeofTag(node);
    if (tag === "thead") {
      const trs = flatten(node.props?.children).filter(
        (n): n is RowChild => isElement(n) && typeofTag(n) === "tr",
      );
      if (trs.length > 0) {
        headers = flatten(trs[0].props?.children)
          .filter((c): c is RowChild => isElement(c) && typeofTag(c) === "th")
          .map((c) => extractText(c.props?.children));
      }
    } else if (tag === "tbody") {
      const trs = flatten(node.props?.children).filter(
        (n): n is RowChild => isElement(n) && typeofTag(n) === "tr",
      );
      for (const tr of trs) {
        const cells = flatten(tr.props?.children)
          .filter((c): c is RowChild => isElement(c) && typeofTag(c) === "td")
          .map((c) => extractText(c.props?.children));
        dataRows.push(cells);
      }
    } else if (tag === "tr") {
      // Fallback: ungrouped <tr> rows
      const cellsTh = flatten(node.props?.children)
        .filter((c): c is RowChild => isElement(c) && typeofTag(c) === "th")
        .map((c) => extractText(c.props?.children));
      if (cellsTh.length > 0 && headers.length === 0) {
        headers = cellsTh;
        continue;
      }
      const cellsTd = flatten(node.props?.children)
        .filter((c): c is RowChild => isElement(c) && typeofTag(c) === "td")
        .map((c) => extractText(c.props?.children));
      if (cellsTd.length > 0) dataRows.push(cellsTd);
    }
  }

  return { headers, dataRows };
}

function flatten(children: ReactNode): ReactNode[] {
  if (children === null || children === undefined || children === false)
    return [];
  if (Array.isArray(children)) return children.flatMap(flatten);
  return [children];
}

function isElement(node: ReactNode): node is ReactElement<ComponentProps<"div">> {
  return typeof node === "object" && node !== null && "type" in node;
}

function typeofTag(el: ReactElement): string {
  const t = el.type;
  if (typeof t === "string") return t;
  return "";
}
