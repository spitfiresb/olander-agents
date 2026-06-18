"use client";

import { type FormEvent, useState, useTransition } from "react";
import { setMaxUploadMbAction } from "./actions";

const SIZE_OPTIONS = [5, 10, 25, 50];

export function UploadSettingsForm({ current }: { current: number }) {
  // Show the current value even if it isn't one of the presets (e.g. set via
  // the old text input), so the dropdown always reflects the real setting.
  const options = SIZE_OPTIONS.includes(current)
    ? SIZE_OPTIONS
    : [...SIZE_OPTIONS, current].sort((a, b) => a - b);
  const [value, setValue] = useState(String(current));
  const [saved, setSaved] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(null);
    startTransition(async () => {
      try {
        const result = await setMaxUploadMbAction(Number(value));
        setSaved(result);
        setValue(String(result));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't save.");
      }
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-wrap items-end gap-3 rounded-2xl border border-brand-charcoal/10 bg-white p-5"
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-brand-ink-soft">Max upload size (MB per file)</span>
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-40 rounded-md border border-brand-charcoal/15 bg-white px-3 py-1.5 text-sm text-brand-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
        >
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt} MB
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-brand-red px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-red/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 disabled:opacity-60"
      >
        {pending ? "Saving…" : "Save"}
      </button>
      {saved !== null ? (
        <p className="w-full text-sm text-brand-charcoal">
          Saved. The per-file upload limit is now <strong>{saved} MB</strong>.
        </p>
      ) : null}
      {error ? <p className="w-full text-sm text-brand-red">{error}</p> : null}
    </form>
  );
}
