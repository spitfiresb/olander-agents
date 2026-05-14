"use client";

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import {
  createScopeAction,
  deleteScopeAction,
  moveViewsAction,
  resetToDefaultsAction,
  updateScopeAction,
} from "./actions";
import type { ScopeRow, ViewMeta } from "./data";

// Kanban-style /admin/scopes editor. Replaces the old list+dropdown UI.
//
// Layout: all buckets visible as a responsive grid of cards, collapsed to a
// header by default — click the chevron to expand and see the views inside.
// Drag a chip into another card (collapsed or expanded) to reassign. Click ⋮
// on a chip for the same operation via keyboard / a11y. Hovering a chip
// shows column-count + sample column names from the bundled P21 schema.
//
// Optimistic UI: drags update the local view→scope mapping instantly via
// useOptimistic; the server action fires in a transition and the page
// revalidates to settle the truth. A failed action snaps back automatically
// because the reducer rebuilds from server props on the next render.

const UNASSIGNED = "__unassigned__";
type Target = string | typeof UNASSIGNED;

// localStorage key for the per-browser "which buckets are expanded" set.
// Keys that no longer exist (renamed/deleted) just sit unused — no GC needed.
const EXPANDED_LS_KEY = "olander.scopes.expanded";

function readExpandedFromStorage(unassignedHasViews: boolean): Set<string> {
  try {
    const raw = window.localStorage.getItem(EXPANDED_LS_KEY);
    if (raw != null) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return new Set(arr.filter((x) => typeof x === "string"));
      }
    }
  } catch {
    // ignore — storage may be disabled / quota exceeded / blocked
  }
  // First visit or unreadable storage: pop Unassigned open if non-empty so
  // the admin sees the deny-by-default warning surface immediately.
  return unassignedHasViews ? new Set([UNASSIGNED]) : new Set();
}

export function ScopesBoard({
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
  // Build the initial view→scope map from props. The UNASSIGNED sentinel
  // is used internally so optimistic updates can move chips into the
  // "unassigned" column without a special-case branch.
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
    (state: Map<string, Target>, action: { viewName: string; to: Target }) => {
      const next = new Map(state);
      next.set(action.viewName, action.to);
      return next;
    },
  );

  // Group views by column for rendering. Recomputes from optimisticMap so a
  // dropped chip appears in the target instantly while the server call is
  // still in flight.
  const columns = useMemo(() => {
    const out: Record<Target, string[]> = { [UNASSIGNED]: [] };
    for (const s of scopes) out[s.key] = [];
    for (const [viewName, target] of optimisticMap) {
      if (!out[target]) out[target] = [];
      out[target].push(viewName);
    }
    for (const key of Object.keys(out)) out[key].sort();
    return out;
  }, [optimisticMap, scopes]);

  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  // Per-browser collapse state. Starts empty (all collapsed); on mount we
  // hydrate from localStorage (or, on the very first visit, expand Unassigned
  // if it has views — that's the deny-by-default surface an admin should
  // notice). The lint rule below normally flags "setState in effect" as a
  // syncing antipattern, but this is the recommended pattern for hydrating
  // from a browser-only API (window.localStorage) in a "use client" component
  // that also needs to SSR — the lazy-initializer alternative would crash on
  // the server.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const initial = readExpandedFromStorage(unassignedViews.length > 0);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpanded(initial);
  }, [unassignedViews.length]);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        EXPANDED_LS_KEY,
        JSON.stringify(Array.from(expanded)),
      );
    } catch {
      // ignore — storage may be disabled (private mode, quota, etc.)
    }
  }, [expanded]);

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function setAllExpanded(value: boolean) {
    if (!value) {
      setExpanded(new Set());
      return;
    }
    const all = new Set<string>(scopes.map((s) => s.key));
    all.add(UNASSIGNED);
    setExpanded(all);
  }

  // While searching, override the collapse state for any bucket that has a
  // matching view — otherwise the search is useless on a collapsed page.
  const searchActive = search.trim().length > 0;
  const autoExpandedFromSearch = useMemo(() => {
    if (!searchActive) return new Set<string>();
    const needle = search.trim().toLowerCase();
    const hits = new Set<string>();
    for (const [viewName, target] of optimisticMap) {
      if (viewName.toLowerCase().includes(needle)) hits.add(target);
    }
    return hits;
  }, [optimisticMap, search, searchActive]);

  function isEffectivelyExpanded(key: string): boolean {
    return expanded.has(key) || autoExpandedFromSearch.has(key);
  }

  // dnd-kit sensors. PointerSensor requires a small drag distance before
  // activating so clicks (e.g. on the ⋮ menu) don't accidentally start a
  // drag. Keyboard sensor gives a11y users space+arrows → enter to drop.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

  function onDragStart(e: DragStartEvent) {
    setActiveDragId(String(e.active.id));
  }

  function onDragEnd(e: DragEndEvent) {
    setActiveDragId(null);
    const viewName = String(e.active.id);
    if (!e.over) return;
    const to = String(e.over.id) as Target;
    if (optimisticMap.get(viewName) === to) return;
    moveChip(viewName, to);
  }

  function moveChip(viewName: string, to: Target) {
    setError(null);
    startTransition(async () => {
      applyOptimistic({ viewName, to });
      try {
        await moveViewsAction([viewName], to === UNASSIGNED ? null : to);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't move view.");
      }
    });
  }

  // For the "Expand all / Collapse all" toolbar: anything expanded?
  const anyExpanded =
    expanded.size > 0 ||
    (searchActive && autoExpandedFromSearch.size > 0);

  return (
    <div>
      <BoardToolbar
        search={search}
        onSearch={setSearch}
        scopeCount={scopes.length}
        viewCount={initialMap.size}
        anyExpanded={anyExpanded}
        onExpandAll={() => setAllExpanded(true)}
        onCollapseAll={() => setAllExpanded(false)}
      />

      {error ? (
        <div className="mb-3 rounded-md border border-brand-red/30 bg-brand-red/5 px-3 py-2 text-sm text-brand-red">
          {error}
        </div>
      ) : null}

      <DndContext
        sensors={sensors}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {scopes.map((s) => (
            <ScopeColumn
              key={s.id}
              scope={s}
              views={columns[s.key] ?? []}
              allScopes={scopes}
              search={search}
              viewMeta={viewMeta}
              activeDragId={activeDragId}
              onMove={moveChip}
              expanded={isEffectivelyExpanded(s.key)}
              onToggleExpanded={() => toggleExpanded(s.key)}
            />
          ))}

          <UnassignedColumn
            views={columns[UNASSIGNED] ?? []}
            allScopes={scopes}
            search={search}
            viewMeta={viewMeta}
            activeDragId={activeDragId}
            onMove={moveChip}
            expanded={isEffectivelyExpanded(UNASSIGNED)}
            onToggleExpanded={() => toggleExpanded(UNASSIGNED)}
          />

          <AddBucketTile />
        </div>

        <DragOverlay dropAnimation={{ duration: 180, easing: "ease-out" }}>
          {activeDragId ? <DraggedChipShadow viewName={activeDragId} /> : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

// --- Toolbar ---------------------------------------------------------------

function BoardToolbar({
  search,
  onSearch,
  scopeCount,
  viewCount,
  anyExpanded,
  onExpandAll,
  onCollapseAll,
}: {
  search: string;
  onSearch: (s: string) => void;
  scopeCount: number;
  viewCount: number;
  anyExpanded: boolean;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}) {
  const [resetOpen, setResetOpen] = useState(false);
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3">
      <div className="relative flex-1 min-w-[180px]">
        <input
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={`Search ${viewCount} views…`}
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
      <div className="text-xs text-brand-ink-soft">
        {scopeCount} bucket{scopeCount === 1 ? "" : "s"}
      </div>
      <button
        type="button"
        onClick={anyExpanded ? onCollapseAll : onExpandAll}
        className="rounded-md border border-brand-charcoal/15 bg-white px-2.5 py-1 text-xs font-medium text-brand-charcoal transition-colors hover:border-brand-charcoal/30"
      >
        {anyExpanded ? "Collapse all" : "Expand all"}
      </button>
      <button
        type="button"
        onClick={() => setResetOpen(true)}
        className="rounded-md border border-brand-charcoal/15 bg-white px-2.5 py-1 text-xs font-medium text-brand-charcoal transition-colors hover:border-brand-charcoal/30"
      >
        Reset to defaults
      </button>
      {resetOpen ? <ResetDialog onClose={() => setResetOpen(false)} /> : null}
    </div>
  );
}

// --- Column (bucket card) --------------------------------------------------

function ScopeColumn({
  scope,
  views,
  allScopes,
  search,
  viewMeta,
  activeDragId,
  onMove,
  expanded,
  onToggleExpanded,
}: {
  scope: ScopeRow;
  views: string[];
  allScopes: ScopeRow[];
  search: string;
  viewMeta: Record<string, ViewMeta>;
  activeDragId: string | null;
  onMove: (viewName: string, to: Target) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: scope.key });
  return (
    <Column
      droppableRef={setNodeRef}
      isOver={isOver}
      isDragging={activeDragId !== null}
      expanded={expanded}
      header={
        <ColumnHeader
          scope={scope}
          viewCount={views.length}
          allScopes={allScopes}
          expanded={expanded}
          onToggleExpanded={onToggleExpanded}
        />
      }
      views={views}
      allScopes={allScopes}
      search={search}
      viewMeta={viewMeta}
      onMove={onMove}
      emptyHint={
        <span>
          Drag a view here, or use the{" "}
          <span className="font-medium">⋮</span> menu on any chip.
        </span>
      }
    />
  );
}

function UnassignedColumn({
  views,
  allScopes,
  search,
  viewMeta,
  activeDragId,
  onMove,
  expanded,
  onToggleExpanded,
}: {
  views: string[];
  allScopes: ScopeRow[];
  search: string;
  viewMeta: Record<string, ViewMeta>;
  activeDragId: string | null;
  onMove: (viewName: string, to: Target) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: UNASSIGNED });
  return (
    <Column
      droppableRef={setNodeRef}
      isOver={isOver}
      isDragging={activeDragId !== null}
      tone={views.length > 0 ? "warning" : "muted"}
      expanded={expanded}
      header={
        <div className="flex items-center justify-between gap-2 px-3 py-2.5">
          <button
            type="button"
            onClick={onToggleExpanded}
            aria-label={expanded ? "Collapse" : "Expand"}
            aria-expanded={expanded}
            className="shrink-0 rounded-md p-1 text-brand-ink-soft transition-colors hover:bg-brand-sand/40 hover:text-brand-charcoal"
          >
            <Chevron open={expanded} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-brand-charcoal">
              Unassigned
            </div>
            <div className="text-[11px] text-brand-ink-soft">
              Denied for non-admins
            </div>
          </div>
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
              views.length > 0
                ? "bg-amber-100 text-amber-800"
                : "bg-brand-charcoal/10 text-brand-ink-soft"
            }`}
          >
            {views.length}
          </span>
        </div>
      }
      views={views}
      allScopes={allScopes}
      search={search}
      viewMeta={viewMeta}
      onMove={onMove}
      emptyHint={<span>Everything is categorized.</span>}
    />
  );
}

function Column({
  droppableRef,
  isOver,
  isDragging,
  header,
  views,
  allScopes,
  search,
  viewMeta,
  onMove,
  tone = "default",
  emptyHint,
  expanded,
}: {
  droppableRef: (node: HTMLDivElement | null) => void;
  isOver: boolean;
  isDragging: boolean;
  header: ReactNode;
  views: string[];
  allScopes: ScopeRow[];
  search: string;
  viewMeta: Record<string, ViewMeta>;
  onMove: (viewName: string, to: Target) => void;
  tone?: "default" | "warning" | "muted";
  emptyHint?: ReactNode;
  expanded: boolean;
}) {
  const filtered = useFiltered(views, search);
  const dim = search.trim().length > 0 && filtered.length === 0;

  const toneBg =
    tone === "warning"
      ? "bg-amber-50/40"
      : tone === "muted"
        ? "bg-brand-canvas/30"
        : "bg-white";
  const overRing =
    isOver && isDragging
      ? "ring-2 ring-brand-red/60 ring-offset-1"
      : "ring-0";

  return (
    <div
      ref={droppableRef}
      className={`flex flex-col rounded-xl border border-brand-charcoal/10 ${toneBg} ${overRing} ${
        dim ? "opacity-50" : ""
      } transition-all ${expanded ? "min-h-[120px]" : ""}`}
    >
      {/* Header always visible; the chevron in it toggles `expanded`. The
          whole column stays a drop target even when collapsed so drag-onto
          a collapsed bucket still works. */}
      <div className={expanded ? "border-b border-brand-charcoal/5" : ""}>
        {header}
      </div>
      {expanded ? (
        <div className="flex-1 space-y-1 overflow-y-auto p-2 max-h-[60vh]">
          {filtered.length === 0 ? (
            <div className="px-2 py-4 text-center text-xs text-brand-ink-soft">
              {emptyHint}
            </div>
          ) : (
            filtered.map((v) => (
              <ViewChip
                key={v}
                viewName={v}
                meta={viewMeta[v]}
                allScopes={allScopes}
                onMove={onMove}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

function useFiltered(views: string[], search: string): string[] {
  return useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return views;
    return views.filter((v) => v.toLowerCase().includes(q));
  }, [views, search]);
}

// --- Column header (inline-editable label + menu) -------------------------

function ColumnHeader({
  scope,
  viewCount,
  allScopes,
  expanded,
  onToggleExpanded,
}: {
  scope: ScopeRow;
  viewCount: number;
  allScopes: ScopeRow[];
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const [editing, setEditing] = useState(false);
  // Local edit buffer; only populated while editing. When not editing, we
  // render `scope.label` directly from props — no sync needed, so revalidation
  // always wins. Initialized fresh each time the user clicks to edit.
  const [editValue, setEditValue] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function startEditing() {
    setEditValue(scope.label);
    setEditing(true);
  }

  function commit() {
    const next = editValue.trim();
    setEditing(false);
    if (!next || next === scope.label) return;
    startTransition(async () => {
      try {
        await updateScopeAction(scope.id, { label: next });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't rename.");
      }
    });
  }

  return (
    <div className="group relative flex items-start gap-2 px-3 py-2.5">
      <button
        type="button"
        onClick={onToggleExpanded}
        aria-label={expanded ? "Collapse" : "Expand"}
        aria-expanded={expanded}
        className="mt-0.5 shrink-0 rounded-md p-1 text-brand-ink-soft transition-colors hover:bg-brand-sand/40 hover:text-brand-charcoal"
      >
        <Chevron open={expanded} />
      </button>
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                setEditing(false);
              }
            }}
            className="w-full rounded-sm border-0 bg-brand-sand/40 px-1 py-0.5 text-sm font-medium text-brand-charcoal outline-none focus:bg-brand-sand/70"
          />
        ) : (
          <button
            type="button"
            onClick={startEditing}
            className="w-full truncate rounded-sm px-1 py-0.5 text-left text-sm font-medium text-brand-charcoal transition-colors hover:bg-brand-sand/40"
            title={scope.description || "Click to rename"}
          >
            {scope.label}
          </button>
        )}
        <div className="px-1 text-[11px] text-brand-ink-soft">
          {viewCount} view{viewCount === 1 ? "" : "s"}
          {scope.defaultForUser ? " · default" : " · opt-in"}
          {scope.memberCount > 0 ? ` · ${scope.memberCount} member` : ""}
          {scope.memberCount > 1 ? "s" : ""}
        </div>
        {error ? (
          <div className="px-1 text-[11px] text-brand-red">{error}</div>
        ) : null}
      </div>

      <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Bucket actions"
          className="rounded-md p-1 text-brand-ink-soft opacity-0 transition-opacity hover:bg-brand-sand/40 hover:text-brand-charcoal group-hover:opacity-100 focus:opacity-100"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor">
            <circle cx="8" cy="3" r="1.4" />
            <circle cx="8" cy="8" r="1.4" />
            <circle cx="8" cy="13" r="1.4" />
          </svg>
        </button>
        {menuOpen ? (
          <ColumnMenu
            scope={scope}
            allScopes={allScopes}
            onClose={() => setMenuOpen(false)}
            onDelete={() => {
              setMenuOpen(false);
              setConfirmDelete(true);
            }}
          />
        ) : null}
      </div>

      {confirmDelete ? (
        <DeleteScopeDialog
          scope={scope}
          onClose={() => setConfirmDelete(false)}
        />
      ) : null}
    </div>
  );
}

function ColumnMenu({
  scope,
  allScopes,
  onClose,
  onDelete,
}: {
  scope: ScopeRow;
  allScopes: ScopeRow[];
  onClose: () => void;
  onDelete: () => void;
}) {
  const [description, setDescription] = useState(scope.description);
  const [defaultForUser, setDefaultForUser] = useState(scope.defaultForUser);
  const [saving, startSaving] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  const allCount = allScopes.length;

  // Click outside closes. Ignore the toggle button itself (which is the
  // sibling that opened us in the first place).
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!ref.current) return;
      if (e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  function saveAndClose() {
    startSaving(async () => {
      const fields: { description?: string; defaultForUser?: boolean } = {};
      if (description !== scope.description) fields.description = description;
      if (defaultForUser !== scope.defaultForUser)
        fields.defaultForUser = defaultForUser;
      if (Object.keys(fields).length > 0) {
        await updateScopeAction(scope.id, fields);
      }
      onClose();
    });
  }

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full z-20 mt-1 w-72 rounded-lg border border-brand-charcoal/15 bg-white p-3 shadow-lg"
    >
      <div className="text-xs uppercase tracking-wide text-brand-ink-soft">
        Description
      </div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        disabled={saving}
        placeholder="What's in this bucket?"
        className="mt-1 w-full rounded-md border border-brand-charcoal/15 bg-white px-2 py-1 text-xs text-brand-charcoal focus:border-brand-red focus:outline-none"
      />

      <label className="mt-2 flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={defaultForUser}
          onChange={(e) => setDefaultForUser(e.target.checked)}
          disabled={saving}
          className="h-3.5 w-3.5 accent-brand-red"
        />
        <span className="text-brand-charcoal">
          Default for new non-admin members
        </span>
      </label>

      <div className="mt-3 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onDelete}
          disabled={saving || allCount <= 1}
          title={
            allCount <= 1 ? "Need at least one bucket" : "Delete this bucket"
          }
          className="rounded-md border border-brand-red/30 bg-white px-2 py-1 text-xs font-medium text-brand-red transition-colors hover:bg-brand-red/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Delete
        </button>
        <button
          type="button"
          onClick={saveAndClose}
          disabled={saving}
          className="rounded-md bg-brand-red px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-brand-red/90 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Done"}
        </button>
      </div>
    </div>
  );
}

// --- View chip (draggable, with menu fallback + tooltip) ------------------

function ViewChip({
  viewName,
  meta,
  allScopes,
  onMove,
}: {
  viewName: string;
  meta: ViewMeta | undefined;
  allScopes: ScopeRow[];
  onMove: (viewName: string, to: Target) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: viewName,
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (!menuRef.current) return;
      if (e.target instanceof Node && menuRef.current.contains(e.target))
        return;
      setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const tooltip =
    meta != null
      ? `${meta.columnCount} columns · ${meta.sampleColumns.slice(0, 3).join(", ")}${
          meta.sampleColumns.length > 3 ? "…" : ""
        }`
      : viewName;

  return (
    <div
      ref={setNodeRef}
      className={`group/chip relative flex items-center justify-between gap-1.5 rounded-md border border-transparent bg-white px-2 py-1 text-xs transition-all hover:border-brand-charcoal/10 hover:bg-brand-sand/30 ${
        isDragging ? "opacity-0" : ""
      }`}
      title={tooltip}
    >
      <button
        type="button"
        {...listeners}
        {...attributes}
        className="flex flex-1 cursor-grab items-center gap-1.5 text-left active:cursor-grabbing"
      >
        <DragGripIcon />
        <code className="truncate font-mono text-brand-charcoal">
          {viewName}
        </code>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
        aria-label={`Move ${viewName}`}
        className="rounded-md p-0.5 text-brand-ink-soft opacity-0 transition-opacity hover:bg-brand-sand/60 hover:text-brand-charcoal group-hover/chip:opacity-100 focus:opacity-100"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor">
          <circle cx="3" cy="8" r="1.3" />
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="13" cy="8" r="1.3" />
        </svg>
      </button>
      {menuOpen ? (
        <div
          ref={menuRef}
          className="absolute right-0 top-full z-20 mt-1 max-h-80 w-56 overflow-y-auto rounded-lg border border-brand-charcoal/15 bg-white py-1 text-xs shadow-lg"
        >
          <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-brand-ink-soft">
            Move to
          </div>
          {allScopes.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => {
                onMove(viewName, s.key);
                setMenuOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left text-brand-charcoal hover:bg-brand-sand/40"
            >
              {s.label}
            </button>
          ))}
          <div className="my-1 border-t border-brand-charcoal/5" />
          <button
            type="button"
            onClick={() => {
              onMove(viewName, UNASSIGNED);
              setMenuOpen(false);
            }}
            className="block w-full px-3 py-1.5 text-left text-brand-red hover:bg-brand-red/10"
          >
            Unassign (deny for non-admins)
          </button>
        </div>
      ) : null}
    </div>
  );
}

function DraggedChipShadow({ viewName }: { viewName: string }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-brand-charcoal/20 bg-white px-2 py-1 text-xs shadow-lg">
      <DragGripIcon />
      <code className="font-mono text-brand-charcoal">{viewName}</code>
    </div>
  );
}

function DragGripIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3 w-3 shrink-0 text-brand-ink-soft/60"
      fill="currentColor"
      aria-hidden
    >
      <circle cx="5" cy="3" r="1.1" />
      <circle cx="5" cy="8" r="1.1" />
      <circle cx="5" cy="13" r="1.1" />
      <circle cx="11" cy="3" r="1.1" />
      <circle cx="11" cy="8" r="1.1" />
      <circle cx="11" cy="13" r="1.1" />
    </svg>
  );
}

// --- Add bucket tile (inline form) ----------------------------------------

function AddBucketTile() {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  function submit() {
    setError(null);
    start(async () => {
      try {
        await createScopeAction({
          key: key.trim(),
          label: label.trim() || key.trim(),
          defaultForUser: false,
        });
        setKey("");
        setLabel("");
        setOpen(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't create.");
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-[120px] flex-col items-center justify-center rounded-xl border border-dashed border-brand-charcoal/20 bg-white text-sm text-brand-ink-soft transition-colors hover:border-brand-charcoal/40 hover:text-brand-charcoal"
      >
        <span className="text-2xl leading-none">＋</span>
        <span className="mt-1">Add bucket</span>
      </button>
    );
  }

  return (
    <div className="flex min-h-[120px] flex-col rounded-xl border border-brand-charcoal/15 bg-white p-3">
      <div className="text-xs uppercase tracking-wide text-brand-ink-soft">
        New bucket
      </div>
      <input
        autoFocus
        type="text"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Label, e.g. Cycle counts"
        disabled={busy}
        className="mt-1 w-full rounded-md border border-brand-charcoal/15 bg-white px-2 py-1 text-sm text-brand-charcoal focus:border-brand-red focus:outline-none"
      />
      <input
        type="text"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="Key (immutable id, e.g. cycle_counts)"
        disabled={busy}
        className="mt-1 w-full rounded-md border border-brand-charcoal/15 bg-white px-2 py-1 font-mono text-xs text-brand-charcoal focus:border-brand-red focus:outline-none"
      />
      {error ? (
        <p className="mt-1 text-[11px] text-brand-red">{error}</p>
      ) : null}
      <div className="mt-auto flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setKey("");
            setLabel("");
          }}
          disabled={busy}
          className="rounded-md border border-brand-charcoal/15 bg-white px-2 py-1 text-xs font-medium text-brand-charcoal hover:bg-brand-charcoal/5 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy || !key.trim()}
          className="rounded-md bg-brand-red px-2 py-1 text-xs font-medium text-white hover:bg-brand-red/90 disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </div>
  );
}

// --- Dialogs (delete, reset) ----------------------------------------------

function DeleteScopeDialog({
  scope,
  onClose,
}: {
  scope: ScopeRow;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
  }, []);

  function submit() {
    setError(null);
    start(async () => {
      try {
        await deleteScopeAction(scope.id);
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't delete.");
      }
    });
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="confirm-dialog w-[calc(100%-3rem)] max-w-md rounded-2xl border border-brand-charcoal/10 bg-white p-6 shadow-2xl"
    >
      <h2 className="text-base font-semibold text-brand-charcoal">
        Delete this bucket?
      </h2>
      <p className="mt-2 text-sm text-brand-ink-soft">
        <span className="font-medium text-brand-charcoal">{scope.label}</span>{" "}
        and its {scope.viewCount} view mapping
        {scope.viewCount === 1 ? "" : "s"} will be removed. Those views become
        unassigned — denied for non-admins until you re-map them.
      </p>
      {scope.memberCount > 0 ? (
        <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {scope.memberCount} member{scope.memberCount === 1 ? "" : "s"}{" "}
          currently reference this bucket. The delete will be refused until
          you clear it from their data access on /admin/members.
        </p>
      ) : null}
      {error ? (
        <p className="mt-3 text-sm text-brand-red">{error}</p>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="rounded-md border border-brand-charcoal/15 bg-white px-3 py-1.5 text-sm font-medium text-brand-charcoal transition-colors hover:bg-brand-charcoal/5 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          autoFocus
          className="rounded-md bg-brand-red px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-red/90 disabled:opacity-60"
        >
          {busy ? "Deleting…" : "Delete"}
        </button>
      </div>
    </dialog>
  );
}

function ResetDialog({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
  }, []);

  function submit() {
    setError(null);
    start(async () => {
      try {
        await resetToDefaultsAction();
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't reset.");
      }
    });
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="confirm-dialog w-[calc(100%-3rem)] max-w-md rounded-2xl border border-brand-charcoal/10 bg-white p-6 shadow-2xl"
    >
      <h2 className="text-base font-semibold text-brand-charcoal">
        Reset to defaults?
      </h2>
      <p className="mt-2 text-sm text-brand-ink-soft">
        Replaces every bucket and every view mapping with the 10-bucket base
        layout. Buckets you added, renamed, or rearranged are wiped.
      </p>
      <p className="mt-2 text-xs text-brand-ink-soft">
        Member overrides aren&apos;t touched — keys that survive the reset
        keep working; keys that don&apos;t are silently dropped on next read.
      </p>
      {error ? <p className="mt-3 text-sm text-brand-red">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="rounded-md border border-brand-charcoal/15 bg-white px-3 py-1.5 text-sm font-medium text-brand-charcoal transition-colors hover:bg-brand-charcoal/5 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="rounded-md bg-brand-red px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-red/90 disabled:opacity-60"
        >
          {busy ? "Resetting…" : "Reset"}
        </button>
      </div>
    </dialog>
  );
}
