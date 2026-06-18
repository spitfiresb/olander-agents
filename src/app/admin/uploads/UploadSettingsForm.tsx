"use client";

import { type FormEvent, useState, useTransition } from "react";
import { setMaxUploadMbAction } from "./actions";

type Props = {
  current: number;
  min: number;
  max: number;
};

export function UploadSettingsForm({ current, min, max }: Props) {
  const [value, setValue] = useState(String(current));
  const [saved, setSaved] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(null);
    const mb = Number(value);
    if (!Number.isFinite(mb) || value.trim() === "") {
      setError("Enter a whole number of megabytes.");
      return;
    }
    startTransition(async () => {
      try {
        const result = await setMaxUploadMbAction(mb);
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
        <input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-40 rounded-md border border-brand-charcoal/15 bg-white px-3 py-1.5 text-sm text-brand-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-brand-red px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-red/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 disabled:opacity-60"
      >
        {pending ? "Saving…" : "Save"}
      </button>
      <p className="w-full text-xs text-brand-ink-soft">
        Allowed range {min}–{max} MB. Values outside the range are clamped. The
        limit applies to each file individually and takes effect immediately.
      </p>
      {saved !== null ? (
        <p className="w-full text-sm text-brand-charcoal">
          Saved — the per-file upload limit is now <strong>{saved} MB</strong>.
        </p>
      ) : null}
      {error ? <p className="w-full text-sm text-brand-red">{error}</p> : null}
    </form>
  );
}
