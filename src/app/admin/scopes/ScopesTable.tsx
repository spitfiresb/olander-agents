"use client";

import { useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  createScopeAction,
  moveViewsAction,
  resetToDefaultsAction,
} from "./actions";
import type { ScopeRow, ViewMeta } from "./data";

// View-first sortable table for /admin/scopes. Replaces the earlier kanban —
// trades drag-and-drop for filterability, bulk-select, and a flat scannable
// list. Same server actions, same useOptimistic-driven mutation pattern.
//
// Filter state (search query, bucket filter, access filter, sort) lives in
// URL params so refresh + deep-link work. Mutations are optimistic: row
// reassignment updates the local view→scope map instantly via useOptimistic,
// the server action fires in a transition, and the page revalidates to
// settle the truth (failed actions snap back on the next render).

const UNASSIGNED = "__unassigned__";
type Target = string | typeof UNASSIGNED;

type SortKey = "view" | "bucket" | "access";
type SortDir = "asc" | "desc";

type Toast = {
  id: number;
  kind: "success" | "error";
  text: string;
};

export function ScopesTable({
  scopes,
  assignments,
  unassignedViews,
  viewMeta,
}: {
  scopes: ScopeRow[];
  assignments: Record<string, string[]>;
  unassignedViews: string[];
  viewMeta: Record<string, ViewMeta>;
}) {
  const totalViews = Object.keys(viewMeta).length;

  // viewName → bucket key (or UNASSIGNED). Single source of truth for
  // rendering; useOptimistic updates it instantly on a reassign.
  const initialMap = useMemo(() => {
    const m = new Map<string, Target>();
    for (const [scopeKey, views] of Object.entries(assignments)) {
      for (const v of views) m.set(v, scopeKey);
    }
    for (const v of unassignedViews) m.set(v, UNASSIGNED);
    return m;
  }, [assignments, unassignedViews]);

  const [optimisticMap, applyOptimistic] = useOptimistic(
    initialMap,
    (
      state: Map<string, Target>,
      action: { viewNames: string[]; to: Target },
    ) => {
      const next = new Map(state);
      for (const v of action.viewNames) next.set(v, action.to);
      return next;
    },
  );

  // --- URL-backed filter state -------------------------------------------
  // Read once on mount; thereafter the local state is the source of truth
  // and we mirror it to the URL via history.replaceState. This avoids a
  // route hop on every keystroke and keeps deep-linking working.
  const urlOnMount = useUrlParamsOnMount();
  const [query, setQuery] = useState(urlOnMount.q);
  const [bucketFilter, setBucketFilter] = useState(urlOnMount.bucket);
  const [accessFilter, setAccessFilter] = useState(urlOnMount.access);
  const [sortKey, setSortKey] = useState<SortKey>(urlOnMount.sortKey);
  const [sortDir, setSortDir] = useState<SortDir>(urlOnMount.sortDir);

  useEffect(() => {
    writeUrlParams({
      q: query,
      bucket: bucketFilter,
      access: accessFilter,
      sort: sortKey === "bucket" && sortDir === "asc" ? "" : `${sortKey}:${sortDir}`,
    });
  }, [query, bucketFilter, accessFilter, sortKey, sortDir]);

  // --- Selection + toasts -------------------------------------------------
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [, startTransition] = useTransition();

  const pushToast = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, kind, text }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  function move(viewNames: string[], to: Target) {
    if (viewNames.length === 0) return;
    startTransition(async () => {
      applyOptimistic({ viewNames, to });
      try {
        await moveViewsAction(viewNames, to === UNASSIGNED ? null : to);
        const targetLabel =
          to === UNASSIGNED
            ? "Unassigned"
            : (scopes.find((s) => s.key === to)?.label ?? to);
        if (viewNames.length === 1) {
          pushToast("success", `Moved ${viewNames[0]} → ${targetLabel}`);
        } else {
          pushToast(
            "success",
            `Moved ${viewNames.length} views to ${targetLabel}`,
          );
        }
        setSelected(new Set());
      } catch (e) {
        pushToast(
          "error",
          e instanceof Error ? e.message : "Couldn't move view(s).",
        );
      }
    });
  }

  // --- Rows + filtering + sorting ----------------------------------------
  const bucketLookup = useMemo(() => {
    const m = new Map<string, ScopeRow>();
    for (const s of scopes) m.set(s.key, s);
    return m;
  }, [scopes]);

  // Wraps the bucket order so 'Unassigned' always sorts last in asc, first
  // in desc. Within a bucket, view names break ties alphabetically.
  function bucketSortValue(target: Target): number {
    if (target === UNASSIGNED) return Number.MAX_SAFE_INTEGER;
    return bucketLookup.get(target)?.sortOrder ?? Number.MAX_SAFE_INTEGER - 1;
  }

  function accessOf(target: Target): "default" | "opt-in" | "denied" {
    if (target === UNASSIGNED) return "denied";
    return bucketLookup.get(target)?.defaultForUser ? "default" : "opt-in";
  }

  const allRows = useMemo(() => {
    const out: { view: string; target: Target }[] = [];
    for (const [view, target] of optimisticMap) out.push({ view, target });
    return out;
  }, [optimisticMap]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allRows.filter((r) => {
      if (q && !r.view.toLowerCase().includes(q)) return false;
      if (bucketFilter) {
        if (bucketFilter === UNASSIGNED) {
          if (r.target !== UNASSIGNED) return false;
        } else if (r.target !== bucketFilter) return false;
      }
      if (accessFilter) {
        const a = accessOf(r.target);
        // 'denied' (unassigned) never matches the access filter — they don't
        // have an access level; filter by Bucket: Unassigned to find them.
        if (a !== accessFilter) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRows, query, bucketFilter, accessFilter, bucketLookup]);

  const sorted = useMemo(() => {
    const rows = filtered.slice();
    const dir = sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      let primary = 0;
      if (sortKey === "view") {
        primary = a.view.localeCompare(b.view);
      } else if (sortKey === "bucket") {
        primary = bucketSortValue(a.target) - bucketSortValue(b.target);
      } else {
        // access — alphabetical: 'default' < 'denied' < 'opt-in' (we want
        // 'denied' last in asc to match its visual TODO weight)
        const order = { default: 0, "opt-in": 1, denied: 2 } as const;
        primary = order[accessOf(a.target)] - order[accessOf(b.target)];
      }
      if (primary !== 0) return primary * dir;
      // Stable secondary sort by view name (alphabetical) so the table
      // doesn't shuffle when rows tie on the primary key.
      return a.view.localeCompare(b.view);
    });
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sortKey, sortDir, bucketLookup]);

  // --- Selection helpers --------------------------------------------------
  const visibleViews = useMemo(() => sorted.map((r) => r.view), [sorted]);
  const visibleSelectedCount = useMemo(
    () => visibleViews.filter((v) => selected.has(v)).length,
    [visibleViews, selected],
  );
  const allVisibleSelected =
    visibleViews.length > 0 && visibleSelectedCount === visibleViews.length;
  const someVisibleSelected =
    visibleSelectedCount > 0 && !allVisibleSelected;

  function toggleSelected(view: string, checked: boolean) {
    setSelected((p) => {
      const next = new Set(p);
      if (checked) next.add(view);
      else next.delete(view);
      return next;
    });
  }

  function selectAllVisible(checked: boolean) {
    setSelected((p) => {
      const next = new Set(p);
      if (checked) for (const v of visibleViews) next.add(v);
      else for (const v of visibleViews) next.delete(v);
      return next;
    });
  }

  function clearFilters() {
    setQuery("");
    setBucketFilter("");
    setAccessFilter("");
  }

  function clearSelection() {
    setSelected(new Set());
  }

  // --- Keyboard shortcuts -------------------------------------------------
  // `/` focus search, `esc` clear selection, `cmd/ctrl+a` select all visible
  // while focus is inside the table. Row arrows + space handled per-row.
  const searchRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as Element | null;
      const inEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (e.key === "/" && !inEditable) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape") {
        if (selected.size > 0) {
          e.preventDefault();
          clearSelection();
        }
      } else if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "a" &&
        tableRef.current &&
        target instanceof Node &&
        tableRef.current.contains(target)
      ) {
        e.preventDefault();
        selectAllVisible(true);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.size, visibleViews]);

  // --- Manage drawer state -----------------------------------------------
  const [manageOpen, setManageOpen] = useState(false);

  return (
    <div>
      <ScopesToolbar
        ref={searchRef}
        query={query}
        onQuery={setQuery}
        bucketFilter={bucketFilter}
        onBucketFilter={setBucketFilter}
        accessFilter={accessFilter}
        onAccessFilter={setAccessFilter}
        scopes={scopes}
        visibleCount={sorted.length}
        totalCount={totalViews}
        onManage={() => setManageOpen(true)}
      />

      {selected.size > 0 ? (
        <BulkActionBar
          count={selected.size}
          scopes={scopes}
          onMove={(target) => move(Array.from(selected), target)}
          onClear={clearSelection}
          onCreateAndMove={async (label) => {
            const viewNames = Array.from(selected);
            const key = slugify(label);
            try {
              await createScopeAction({
                key,
                label,
                defaultForUser: false,
              });
              await moveViewsAction(viewNames, key);
              setSelected(new Set());
              pushToast(
                "success",
                `Moved ${viewNames.length} view${viewNames.length === 1 ? "" : "s"} to ${label}`,
              );
            } catch (e) {
              pushToast(
                "error",
                e instanceof Error ? e.message : "Couldn't create bucket.",
              );
            }
          }}
        />
      ) : null}

      <div className="mt-3 overflow-hidden rounded-2xl border border-brand-charcoal/10 bg-white">
        <table
          ref={tableRef}
          className="w-full border-collapse text-sm"
          aria-label="P21 views by bucket"
        >
          <thead className="bg-brand-canvas/40 text-left text-xs uppercase tracking-wide text-brand-ink-soft">
            <tr>
              <th className="w-10 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="Select all visible"
                  checked={allVisibleSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someVisibleSelected;
                  }}
                  onChange={(e) => selectAllVisible(e.target.checked)}
                  disabled={visibleViews.length === 0}
                  className="h-3.5 w-3.5 accent-brand-red"
                />
              </th>
              <SortableTh
                label="View"
                active={sortKey === "view"}
                dir={sortDir}
                onClick={() => toggleSort("view")}
                className="px-3 py-2"
              />
              <SortableTh
                label="Bucket"
                active={sortKey === "bucket"}
                dir={sortDir}
                onClick={() => toggleSort("bucket")}
                className="w-40 px-3 py-2"
              />
              <SortableTh
                label="Access"
                active={sortKey === "access"}
                dir={sortDir}
                onClick={() => toggleSort("access")}
                className="w-20 px-3 py-2"
              />
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-10 text-center">
                  <div className="text-sm text-brand-ink-soft">
                    No views match these filters.
                  </div>
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="mt-2 text-xs font-medium text-brand-red hover:underline"
                  >
                    Clear filters
                  </button>
                </td>
              </tr>
            ) : (
              sorted.map((r, i) => (
                <Row
                  key={r.view}
                  view={r.view}
                  target={r.target}
                  scopes={scopes}
                  selected={selected.has(r.view)}
                  zebra={i % 2 === 1}
                  onSelect={(checked) => toggleSelected(r.view, checked)}
                  onMove={(to) => move([r.view], to)}
                  bucketLabel={
                    r.target === UNASSIGNED
                      ? "Unassigned"
                      : (bucketLookup.get(r.target)?.label ?? r.target)
                  }
                  access={accessOf(r.target)}
                  meta={viewMeta[r.view]}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {manageOpen ? (
        <ManageBucketsDrawer
          scopes={scopes}
          onClose={() => setManageOpen(false)}
          onReset={async () => {
            try {
              await resetToDefaultsAction();
              pushToast("success", "Reset to the 10-bucket base layout.");
              setManageOpen(false);
            } catch (e) {
              pushToast(
                "error",
                e instanceof Error ? e.message : "Couldn't reset.",
              );
            }
          }}
        />
      ) : null}

      <ToastStack toasts={toasts} />
    </div>
  );

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }
}

// --- Toolbar --------------------------------------------------------------

const ScopesToolbar = function ScopesToolbar({
  ref,
  query,
  onQuery,
  bucketFilter,
  onBucketFilter,
  accessFilter,
  onAccessFilter,
  scopes,
  visibleCount,
  totalCount,
  onManage,
}: {
  ref: React.RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (s: string) => void;
  bucketFilter: string;
  onBucketFilter: (s: string) => void;
  accessFilter: string;
  onAccessFilter: (s: string) => void;
  scopes: ScopeRow[];
  visibleCount: number;
  totalCount: number;
  onManage: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[180px] flex-[2_1_240px]">
        <input
          ref={ref}
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search views — press / to focus"
          className="w-full rounded-md border border-brand-charcoal/15 bg-white px-3 py-1.5 pl-8 text-sm text-brand-charcoal focus:border-brand-red focus:outline-none"
        />
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-brand-ink-soft"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="9" cy="9" r="6" />
          <path d="M14 14l3 3" strokeLinecap="round" />
        </svg>
      </div>
      <select
        value={bucketFilter}
        onChange={(e) => onBucketFilter(e.target.value)}
        className="rounded-md border border-brand-charcoal/15 bg-white px-2 py-1.5 text-xs text-brand-charcoal focus:border-brand-red focus:outline-none"
        aria-label="Filter by bucket"
      >
        <option value="">Any bucket</option>
        <option value={UNASSIGNED}>Unassigned</option>
        {scopes.map((s) => (
          <option key={s.key} value={s.key}>
            {s.label}
          </option>
        ))}
      </select>
      <select
        value={accessFilter}
        onChange={(e) => onAccessFilter(e.target.value)}
        className="rounded-md border border-brand-charcoal/15 bg-white px-2 py-1.5 text-xs text-brand-charcoal focus:border-brand-red focus:outline-none"
        aria-label="Filter by access"
      >
        <option value="">Any access</option>
        <option value="default">default</option>
        <option value="opt-in">opt-in</option>
      </select>
      <div className="ml-auto flex items-center gap-3 text-xs text-brand-ink-soft">
        <span>
          Showing <span className="tabular-nums">{visibleCount}</span> of{" "}
          <span className="tabular-nums">{totalCount}</span>
        </span>
        <button
          type="button"
          onClick={onManage}
          className="rounded-md border border-brand-charcoal/15 bg-white px-2.5 py-1 text-xs font-medium text-brand-charcoal transition-colors hover:border-brand-charcoal/30"
        >
          Manage buckets
        </button>
      </div>
    </div>
  );
};

// --- Bulk action bar (sticky-ish, sits below the toolbar) -----------------

function BulkActionBar({
  count,
  scopes,
  onMove,
  onClear,
  onCreateAndMove,
}: {
  count: number;
  scopes: ScopeRow[];
  onMove: (to: Target) => void;
  onClear: () => void;
  onCreateAndMove: (label: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sticky top-2 z-10 mt-3 flex items-center gap-2 rounded-lg border border-brand-charcoal/15 bg-white px-3 py-2 shadow-sm">
      <span className="text-sm font-medium text-brand-charcoal">
        {count} selected
      </span>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-md bg-brand-red px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-brand-red/90"
        >
          Move to ▾
        </button>
        {open ? (
          <BucketPopover
            scopes={scopes}
            includeUnassign
            onPick={(to) => {
              setOpen(false);
              onMove(to);
            }}
            onCreate={async (label) => {
              setOpen(false);
              await onCreateAndMove(label);
            }}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </div>
      <button
        type="button"
        onClick={onClear}
        className="ml-auto rounded-md px-2.5 py-1 text-xs font-medium text-brand-ink-soft transition-colors hover:bg-brand-charcoal/5"
      >
        Clear
      </button>
    </div>
  );
}

// --- Table row ------------------------------------------------------------

function Row({
  view,
  target,
  scopes,
  selected,
  zebra,
  onSelect,
  onMove,
  bucketLabel,
  access,
  meta,
}: {
  view: string;
  target: Target;
  scopes: ScopeRow[];
  selected: boolean;
  zebra: boolean;
  onSelect: (checked: boolean) => void;
  onMove: (to: Target) => void;
  bucketLabel: string;
  access: "default" | "opt-in" | "denied";
  meta: ViewMeta | undefined;
}) {
  const tooltip =
    meta != null
      ? `${meta.columnCount} columns · ${meta.sampleColumns.slice(0, 3).join(", ")}${
          meta.sampleColumns.length > 3 ? "…" : ""
        }`
      : view;
  return (
    <tr
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === " ") {
          e.preventDefault();
          onSelect(!selected);
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          const dir = e.key === "ArrowDown" ? 1 : -1;
          const rows = (e.currentTarget.parentElement?.children ?? []) as
            | HTMLCollection
            | never[];
          const arr = Array.from(rows) as HTMLElement[];
          const idx = arr.indexOf(e.currentTarget as HTMLElement);
          const next = arr[idx + dir];
          if (next) {
            e.preventDefault();
            (next as HTMLElement).focus();
          }
        }
      }}
      className={`${zebra ? "bg-brand-canvas/20" : "bg-white"} transition-colors focus:bg-brand-sand/30 focus:outline-none ${
        selected ? "bg-brand-red/5" : ""
      }`}
    >
      <td className="px-3 py-1.5 align-middle">
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => onSelect(e.target.checked)}
          aria-label={`Select ${view}`}
          className="h-3.5 w-3.5 accent-brand-red"
        />
      </td>
      <td className="px-3 py-1.5 align-middle">
        <code
          className="font-mono text-xs text-brand-charcoal"
          title={tooltip}
        >
          {view}
        </code>
      </td>
      <td className="px-3 py-1.5 align-middle">
        <BucketPill
          target={target}
          label={bucketLabel}
          scopes={scopes}
          onMove={onMove}
        />
      </td>
      <td className="px-3 py-1.5 align-middle text-xs">
        <AccessLabel access={access} />
      </td>
    </tr>
  );
}

function AccessLabel({ access }: { access: "default" | "opt-in" | "denied" }) {
  if (access === "denied")
    return <span className="text-amber-700">denied</span>;
  if (access === "opt-in")
    return <span className="text-amber-700">opt-in</span>;
  return <span className="text-brand-ink-soft">default</span>;
}

// --- BucketPill + Popover -------------------------------------------------

function BucketPill({
  target,
  label,
  scopes,
  onMove,
}: {
  target: Target;
  label: string;
  scopes: ScopeRow[];
  onMove: (to: Target) => void;
}) {
  const [open, setOpen] = useState(false);
  const unassigned = target === UNASSIGNED;
  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
          unassigned
            ? "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
            : "border-brand-charcoal/15 bg-white text-brand-charcoal hover:border-brand-charcoal/30"
        }`}
      >
        <span className="truncate">{label}</span>
        <Caret />
      </button>
      {open ? (
        <BucketPopover
          scopes={scopes}
          includeUnassign={!unassigned}
          currentKey={unassigned ? null : target}
          onPick={(to) => {
            setOpen(false);
            if (to !== target) onMove(to);
          }}
          onCreate={async (newLabel) => {
            setOpen(false);
            try {
              const key = slugify(newLabel);
              await createScopeAction({
                key,
                label: newLabel,
                defaultForUser: false,
              });
              onMove(key);
            } catch (e) {
              // Surface the error inline; the toast layer is one level up,
              // so re-throw and let the parent's move handler not fire.
              console.error(e);
            }
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function BucketPopover({
  scopes,
  includeUnassign,
  currentKey,
  onPick,
  onCreate,
  onClose,
}: {
  scopes: ScopeRow[];
  includeUnassign?: boolean;
  currentKey?: string | null;
  onPick: (to: Target) => void;
  onCreate: (label: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [creating, setCreating] = useState(false);
  const [newLabel, setNewLabel] = useState("");

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!ref.current) return;
      if (e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      className="absolute left-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-lg border border-brand-charcoal/15 bg-white py-1 text-xs shadow-lg"
    >
      <div className="max-h-64 overflow-y-auto">
        {scopes.map((s) => {
          const isCurrent = currentKey === s.key;
          return (
            <button
              key={s.key}
              type="button"
              role="menuitem"
              onClick={() => onPick(s.key)}
              disabled={isCurrent}
              className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-brand-charcoal hover:bg-brand-sand/40 disabled:cursor-default disabled:bg-brand-canvas/40 disabled:text-brand-ink-soft`}
            >
              <span className="truncate">{s.label}</span>
              {isCurrent ? (
                <span className="text-[10px] uppercase tracking-wide text-brand-ink-soft">
                  current
                </span>
              ) : !s.defaultForUser ? (
                <span className="text-[10px] uppercase tracking-wide text-amber-700">
                  opt-in
                </span>
              ) : null}
            </button>
          );
        })}
        {includeUnassign ? (
          <button
            type="button"
            role="menuitem"
            onClick={() => onPick(UNASSIGNED)}
            className="flex w-full items-center px-3 py-1.5 text-left text-amber-800 hover:bg-amber-50"
          >
            Unassign (deny for non-admins)
          </button>
        ) : null}
      </div>
      <div className="border-t border-brand-charcoal/5" />
      {creating ? (
        <div className="p-2">
          <input
            autoFocus
            type="text"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newLabel.trim()) {
                onCreate(newLabel.trim());
              } else if (e.key === "Escape") {
                setCreating(false);
                setNewLabel("");
              }
            }}
            placeholder="New bucket label"
            className="w-full rounded-md border border-brand-charcoal/15 px-2 py-1 text-xs focus:border-brand-red focus:outline-none"
          />
          <div className="mt-1 flex justify-end gap-1">
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setNewLabel("");
              }}
              className="rounded-md px-2 py-0.5 text-[11px] text-brand-ink-soft hover:bg-brand-charcoal/5"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => newLabel.trim() && onCreate(newLabel.trim())}
              disabled={!newLabel.trim()}
              className="rounded-md bg-brand-red px-2 py-0.5 text-[11px] font-medium text-white hover:bg-brand-red/90 disabled:opacity-50"
            >
              Create
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="block w-full px-3 py-1.5 text-left text-brand-charcoal hover:bg-brand-sand/40"
        >
          Move to new bucket…
        </button>
      )}
    </div>
  );
}

// --- Header sort affordance ------------------------------------------------

function SortableTh({
  label,
  active,
  dir,
  onClick,
  className,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  className?: string;
}) {
  return (
    <th className={className} scope="col" aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-1 text-left text-xs uppercase tracking-wide text-brand-ink-soft hover:text-brand-charcoal"
      >
        <span>{label}</span>
        <span aria-hidden className="text-brand-ink-soft/60">
          {active ? (dir === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}

// --- Manage buckets drawer (mostly a stub) --------------------------------

function ManageBucketsDrawer({
  scopes,
  onClose,
  onReset,
}: {
  scopes: ScopeRow[];
  onClose: () => void;
  onReset: () => void | Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, start] = useTransition();

  return (
    <div
      className="fixed inset-0 z-40"
      role="dialog"
      aria-modal="true"
      aria-label="Manage buckets"
    >
      <div
        className="absolute inset-0 bg-brand-charcoal/30"
        onClick={onClose}
      />
      <aside className="absolute right-0 top-0 h-full w-full max-w-md overflow-y-auto bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-brand-charcoal">
            Manage buckets
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-brand-ink-soft hover:bg-brand-charcoal/5"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <p className="mt-1 text-xs text-brand-ink-soft">
          Renaming, adding, deleting, and access-level toggling are coming
          soon. For now, the Reset action and a read-only summary live here.
        </p>

        <ul className="mt-4 divide-y divide-brand-charcoal/5 rounded-lg border border-brand-charcoal/10">
          {scopes.map((s) => (
            <li
              key={s.key}
              className="flex items-center justify-between px-3 py-2 text-sm"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-brand-charcoal">
                  {s.label}
                </div>
                <div className="truncate text-[11px] text-brand-ink-soft">
                  <code className="font-mono">{s.key}</code>
                  {s.description ? ` · ${s.description}` : ""}
                </div>
              </div>
              <div className="ml-2 flex shrink-0 items-center gap-2 text-[10px] uppercase tracking-wide">
                <span
                  className={`rounded-full px-1.5 py-0.5 ${
                    s.defaultForUser
                      ? "bg-brand-charcoal/5 text-brand-ink-soft"
                      : "bg-amber-50 text-amber-700"
                  }`}
                >
                  {s.defaultForUser ? "default" : "opt-in"}
                </span>
                <span className="text-brand-ink-soft tabular-nums">
                  {s.viewCount}
                </span>
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
          <div className="text-xs font-medium text-amber-900">
            Reset to defaults
          </div>
          <p className="mt-1 text-[11px] text-amber-800">
            Wipes every bucket and view mapping, then re-seeds the 10-bucket
            base layout. Buckets you renamed or added are removed; member
            overrides keep working for any keys that survive.
          </p>
          {confirming ? (
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="rounded-md border border-brand-charcoal/15 bg-white px-2.5 py-1 text-xs font-medium text-brand-charcoal disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => start(async () => { await onReset(); })}
                disabled={busy}
                className="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-60"
              >
                {busy ? "Resetting…" : "Confirm reset"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="mt-2 rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
            >
              Reset to defaults…
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}

// --- Toast stack ----------------------------------------------------------

function ToastStack({ toasts }: { toasts: Toast[] }) {
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          className={`pointer-events-auto rounded-lg border px-3 py-2 text-sm shadow-md transition-opacity ${
            t.kind === "error"
              ? "border-brand-red/30 bg-white text-brand-red"
              : "border-brand-charcoal/15 bg-white text-brand-charcoal"
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

// --- Helpers --------------------------------------------------------------

function Caret() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="h-2.5 w-2.5 text-brand-ink-soft"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/__+/g, "_")
    .slice(0, 48) || "bucket";
}

// --- URL params -----------------------------------------------------------

function useUrlParamsOnMount(): {
  q: string;
  bucket: string;
  access: string;
  sortKey: SortKey;
  sortDir: SortDir;
} {
  const params = useSearchParams();
  // Read once on mount; this is the page's "initial state" derived from a
  // shareable URL. Subsequent updates come from local state writing back to
  // the URL via history.replaceState.
  const sort = params.get("sort") ?? "";
  const [rawKey, rawDir] = sort.split(":");
  const sortKey: SortKey =
    rawKey === "view" || rawKey === "access" ? rawKey : "bucket";
  const sortDir: SortDir = rawDir === "desc" ? "desc" : "asc";
  return {
    q: params.get("q") ?? "",
    bucket: params.get("bucket") ?? "",
    access: params.get("access") ?? "",
    sortKey,
    sortDir,
  };
}

function writeUrlParams(values: {
  q: string;
  bucket: string;
  access: string;
  sort: string;
}) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  window.history.replaceState(null, "", url.toString());
}
