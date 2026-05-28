"use client";

import { useMemo, useState, useTransition } from "react";
import type { ScopeBucket } from "@/lib/scopes";
import { setMemberScopesAction } from "./actions";
import type { ScopeTarget } from "./ScopePickerDialog";

// Form body of ScopePickerDialog. Lives in a sibling file so the dialog can
// `key={target.email}` it for a fresh local-state mount per opened row —
// avoids needing useEffect+setState to reset the picked-set when target
// changes (which the react-hooks lint rule rejects).
export function ScopePickerForm({
  target,
  buckets,
  defaultKeys,
  onCancel,
  onSaved,
}: {
  target: ScopeTarget;
  buckets: ScopeBucket[];
  defaultKeys: string[];
  onCancel: () => void;
  onSaved: (email: string, scopes: string[] | null) => void;
}) {
  const [useDefault, setUseDefault] = useState(target.initial === null);
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(target.initial ?? defaultKeys),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const defaultSet = useMemo(() => new Set(defaultKeys), [defaultKeys]);
  const defaultLabel = useMemo(
    () =>
      buckets
        .filter((b) => defaultSet.has(b.key))
        .map((b) => b.label)
        .join(", "),
    [buckets, defaultSet],
  );

  function togglePicked(s: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  function save() {
    setError(null);
    const value: string[] | null = useDefault
      ? null
      : buckets.filter((b) => picked.has(b.key)).map((b) => b.key);
    startSaving(async () => {
      try {
        await setMemberScopesAction(target.email, value);
        onSaved(target.email, value);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't save data access.");
      }
    });
  }

  return (
    <div>
      <h2
        id="scope-picker-title"
        className="text-base font-semibold text-brand-charcoal"
      >
        Data access — {target.label}
      </h2>
      <p className="mt-1 text-sm text-brand-ink-soft">
        Pick the P21 data buckets this member can query through the chat.
        Admins always have full access; this list is for regular members.
      </p>

      <label className="mt-4 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={useDefault}
          onChange={(e) => setUseDefault(e.target.checked)}
          disabled={saving}
          className="mt-0.5 h-4 w-4 accent-brand-red"
        />
        <span>
          <span className="font-medium text-brand-charcoal">
            Use tier default
          </span>
          <span className="ml-1 text-brand-ink-soft">({defaultLabel})</span>
        </span>
      </label>

      <fieldset
        disabled={useDefault || saving}
        className="mt-3 grid gap-2 rounded-xl border border-brand-charcoal/10 p-3 disabled:opacity-50"
      >
        <legend className="px-1 text-xs uppercase tracking-wide text-brand-ink-soft">
          Custom buckets
        </legend>
        {buckets.map((b) => {
          const checked = picked.has(b.key);
          const isDefault = defaultSet.has(b.key);
          return (
            <label
              key={b.key}
              className="flex items-start gap-2 rounded-md px-1 py-1 text-sm hover:bg-brand-sand/30"
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => togglePicked(b.key)}
                className="mt-0.5 h-4 w-4 accent-brand-red"
              />
              <span>
                <span className="font-medium text-brand-charcoal">
                  {b.label}
                </span>
                {!isDefault ? (
                  <span className="ml-2 rounded-full bg-brand-red/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-brand-red">
                    sensitive
                  </span>
                ) : null}
                <span className="block text-[12px] text-brand-ink-soft">
                  {b.description}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>

      {error ? <p className="mt-3 text-sm text-brand-red">{error}</p> : null}

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-md border border-brand-charcoal/15 bg-white px-3 py-1.5 text-sm font-medium text-brand-charcoal transition-colors hover:bg-brand-charcoal/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-charcoal/30 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-md bg-brand-red px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-red/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save data access"}
        </button>
      </div>
    </div>
  );
}
