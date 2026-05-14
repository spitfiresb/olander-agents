"use client";

import {
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";
import { moveViewsAction, resetToDefaultsAction } from "./actions";
import type { ScopeRow, ViewMeta } from "./data";

// Quiet grouped list for /admin/scopes. Bucket headers are collapsed by
// default; expand a bucket to see its views as a list, each with a single
// Move dropdown to reassign. Unassigned views (deny-by-default) surface as
// an amber callout at the top — the only thing the admin needs to notice
// without clicking anything.
//
// No search, no filters, no bulk-select, no sortable headers — this page
// gets visited rarely, and when it is, the one job ("which bucket does this
// view live in?") needs to be obvious at a glance.

const UNASSIGNED = "__unassigned__";
type Target = string | typeof UNASSIGNED;
const EXPANDED_LS_KEY = "olander.scopes.expanded";

export function ScopesList({
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
      action: { viewName: string; to: Target },
    ) => {
      const next = new Map(state);
      next.set(action.viewName, action.to);
      return next;
    },
  );

  // Group the live map back out by bucket for rendering.
  const byBucket = useMemo(() => {
    const out: Record<Target, string[]> = { [UNASSIGNED]: [] };
    for (const s of scopes) out[s.key] = [];
    for (const [view, target] of optimisticMap) {
      (out[target] ??= []).push(view);
    }
    for (const k of Object.keys(out)) out[k].sort();
    return out;
  }, [optimisticMap, scopes]);

  const unassigned = byBucket[UNASSIGNED] ?? [];

  // Per-browser collapse state, hydrated from localStorage on mount. The
  // setState-in-effect lint rule is the wrong call here — this is exactly
  // the "external system → React state" sync the rule's docs describe as a
  // valid use.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let next: Set<string>;
    try {
      const raw = window.localStorage.getItem(EXPANDED_LS_KEY);
      const arr = raw ? JSON.parse(raw) : null;
      next = Array.isArray(arr)
        ? new Set(arr.filter((x: unknown): x is string => typeof x === "string"))
        : new Set();
    } catch {
      next = new Set();
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpanded(next);
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        EXPANDED_LS_KEY,
        JSON.stringify(Array.from(expanded)),
      );
    } catch {
      // storage disabled — fine; we just lose the persistence
    }
  }, [expanded]);

  function toggle(key: string) {
    setExpanded((p) => {
      const next = new Set(p);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function move(viewName: string, to: Target) {
    setError(null);
    startTransition(async () => {
      applyOptimistic({ viewName, to });
      try {
        await moveViewsAction([viewName], to === UNASSIGNED ? null : to);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't move view.");
      }
    });
  }

  const [resetOpen, setResetOpen] = useState(false);

  return (
    <div>
      {unassigned.length > 0 ? (
        <UnassignedCallout
          views={unassigned}
          scopes={scopes}
          onAssign={move}
        />
      ) : null}

      <div
        className={`${
          unassigned.length > 0 ? "mt-4" : ""
        } divide-y divide-brand-charcoal/10 overflow-hidden rounded-2xl border border-brand-charcoal/10 bg-white`}
      >
        {scopes.map((s) => (
          <BucketSection
            key={s.key}
            scope={s}
            views={byBucket[s.key] ?? []}
            allScopes={scopes}
            expanded={expanded.has(s.key)}
            onToggle={() => toggle(s.key)}
            onMove={move}
            viewMeta={viewMeta}
          />
        ))}
      </div>

      {error ? (
        <p className="mt-3 text-sm text-brand-red" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={() => setResetOpen(true)}
          className="inline-flex items-center rounded-full border border-brand-charcoal/15 bg-white px-3 py-1 text-xs font-medium text-brand-ink-soft shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-brand-red/40 hover:bg-brand-red/5 hover:text-brand-red hover:shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-1"
        >
          Reset to defaults
        </button>
      </div>

      {resetOpen ? (
        <ResetDialog onClose={() => setResetOpen(false)} />
      ) : null}
    </div>
  );
}

// --- Unassigned callout (the one thing that demands attention) ------------

function UnassignedCallout({
  views,
  scopes,
  onAssign,
}: {
  views: string[];
  scopes: ScopeRow[];
  onAssign: (viewName: string, to: Target) => void;
}) {
  return (
    <div className="rounded-2xl border border-amber-300 bg-amber-50/60 p-4">
      <div className="text-sm font-medium text-amber-900">
        {views.length} unassigned view{views.length === 1 ? "" : "s"}
      </div>
      <p className="mt-0.5 text-xs text-amber-800">
        Non-admins can&apos;t read these until you put them in a bucket.
      </p>
      <ul className="mt-2 space-y-1">
        {views.map((v) => (
          <li
            key={v}
            className="flex items-center justify-between gap-2 rounded-md bg-white/70 px-2 py-1"
          >
            <code className="truncate font-mono text-xs text-brand-charcoal">
              {v}
            </code>
            <MovePopover
              currentLabel="Assign…"
              currentKey={null}
              scopes={scopes}
              onPick={(to) => onAssign(v, to)}
              variant="amber"
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- Bucket section (collapsed by default) --------------------------------

function BucketSection({
  scope,
  views,
  allScopes,
  expanded,
  onToggle,
  onMove,
  viewMeta,
}: {
  scope: ScopeRow;
  views: string[];
  allScopes: ScopeRow[];
  expanded: boolean;
  onToggle: () => void;
  onMove: (viewName: string, to: Target) => void;
  viewMeta: Record<string, ViewMeta>;
}) {
  return (
    <section>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        title={scope.description || undefined}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-200 hover:bg-brand-sand/40 focus-visible:bg-brand-sand/40 focus-visible:outline-none"
      >
        <Chevron open={expanded} />
        <span className="flex-1 truncate text-sm font-medium text-brand-charcoal">
          {scope.label}
        </span>
        <span className="text-xs tabular-nums text-brand-ink-soft">
          {views.length} view{views.length === 1 ? "" : "s"}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${
            scope.defaultForUser
              ? "bg-brand-charcoal/5 text-brand-ink-soft"
              : "bg-amber-100 text-amber-800"
          }`}
        >
          {scope.defaultForUser ? "default" : "opt-in"}
        </span>
      </button>
      {/* Animated expand/collapse via the grid-rows trick: parent transitions
          grid-template-rows between 0fr and 1fr, child is overflow-hidden so
          the visible height slides smoothly. The body is always mounted so
          the animation has something to interpolate to/from. */}
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
        aria-hidden={!expanded}
      >
        <div className="overflow-hidden">
          <ul className="border-t border-brand-charcoal/5 bg-brand-canvas/20">
            {views.length === 0 ? (
              <li className="px-4 py-3 text-xs italic text-brand-ink-soft">
                No views in this bucket.
              </li>
            ) : (
              views.map((v) => (
                <li
                  key={v}
                  className="flex items-center justify-between gap-2 border-b border-brand-charcoal/5 px-4 py-1.5 last:border-b-0"
                >
                  <code
                    className="truncate font-mono text-xs text-brand-charcoal"
                    title={viewTooltip(v, viewMeta[v])}
                  >
                    {v}
                  </code>
                  <MovePopover
                    currentLabel="Move"
                    currentKey={scope.key}
                    scopes={allScopes}
                    onPick={(to) => onMove(v, to)}
                  />
                </li>
              ))
            )}
          </ul>
        </div>
      </div>
    </section>
  );
}

function viewTooltip(view: string, meta: ViewMeta | undefined): string {
  if (!meta) return view;
  const sample = meta.sampleColumns.slice(0, 3).join(", ");
  return `${meta.columnCount} columns · ${sample}${
    meta.sampleColumns.length > 3 ? "…" : ""
  }`;
}

// --- Move popover (the only interaction on the page) ----------------------

function MovePopover({
  currentLabel,
  currentKey,
  scopes,
  onPick,
  variant = "default",
}: {
  currentLabel: string;
  currentKey: string | null;
  scopes: ScopeRow[];
  onPick: (to: Target) => void;
  variant?: "default" | "amber";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current) return;
      if (e.target instanceof Node && ref.current.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Pill triggers — animated hover for color + shadow, but no translate
  // because the popover anchors absolute below them and shifting the button
  // would shift the popover with it.
  const triggerClass =
    variant === "amber"
      ? "border-amber-300 bg-white text-amber-800 hover:border-amber-400 hover:bg-amber-100 hover:shadow-sm focus-visible:ring-amber-500"
      : "border-brand-charcoal/15 bg-white text-brand-charcoal hover:border-brand-red/40 hover:bg-brand-red/5 hover:text-brand-red hover:shadow-sm focus-visible:ring-brand-red";

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 ${triggerClass} ${
          open ? "shadow-sm" : ""
        }`}
        aria-expanded={open}
      >
        <span>{currentLabel}</span>
        <Caret />
      </button>
      {/* Always rendered, animated in/out via opacity + scale + origin-top-right
          so the menu blooms from the trigger pill below it. `inert` when
          closed keeps the items out of the keyboard tab order. */}
      <div
        role="menu"
        inert={!open}
        aria-hidden={!open}
        className={`absolute right-0 top-full z-20 mt-1 w-56 origin-top-right overflow-hidden rounded-lg border border-brand-charcoal/15 bg-white py-1 text-xs shadow-lg transition-all duration-150 ease-out ${
          open
            ? "pointer-events-auto scale-100 opacity-100"
            : "pointer-events-none scale-95 opacity-0"
        }`}
      >
        <div className="max-h-72 overflow-y-auto">
          {scopes.map((s) => {
            const isCurrent = currentKey === s.key;
            return (
              <button
                key={s.key}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  if (!isCurrent) onPick(s.key);
                }}
                disabled={isCurrent}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-brand-charcoal transition-colors duration-150 hover:bg-brand-sand/40 disabled:cursor-default disabled:bg-brand-canvas/40 disabled:text-brand-ink-soft"
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
        </div>
      </div>
    </div>
  );
}

// --- Reset confirm dialog -------------------------------------------------

function ResetDialog({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
  }, []);

  function doReset() {
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

  function onBackdropClick(e: React.MouseEvent<HTMLDialogElement>) {
    if (e.target === dialogRef.current && !busy) onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={onBackdropClick}
      className="confirm-dialog w-[calc(100%-3rem)] max-w-md rounded-2xl border border-brand-charcoal/10 bg-white p-6 shadow-2xl"
    >
      <h2 className="text-base font-semibold text-brand-charcoal">
        Reset to defaults?
      </h2>
      <p className="mt-2 text-sm text-brand-ink-soft">
        Wipes every bucket and view mapping, then re-seeds the 10-bucket base
        layout. Member overrides keep working for any keys that survive the
        reset; the rest are silently dropped on next read.
      </p>
      {error ? (
        <p className="mt-3 text-sm text-brand-red">{error}</p>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="rounded-md border border-brand-charcoal/15 bg-white px-3 py-1.5 text-sm font-medium text-brand-charcoal transition-colors hover:bg-brand-charcoal/5 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={doReset}
          disabled={busy}
          autoFocus
          className="rounded-md bg-brand-red px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-red/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Resetting…" : "Reset"}
        </button>
      </div>
    </dialog>
  );
}

// --- Tiny icons ------------------------------------------------------------

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={`h-3.5 w-3.5 shrink-0 text-brand-ink-soft transition-transform ${
        open ? "rotate-90" : ""
      }`}
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
