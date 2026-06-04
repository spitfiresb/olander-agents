"use client";

import { useTransition } from "react";
import { setTrialEnabledAction, setTrialLimitAction } from "./actions";

// Client controls for the TEMPORARY trial gate. Limit edit posts via a form
// action; the on/off toggle runs in a transition. Errors fall to the admin
// error boundary (acceptable for an admin-only tool, matching /admin/members).

export function TrialControls({
  enabled,
  limitUsd,
}: {
  enabled: boolean;
  limitUsd: number;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="mt-6 space-y-5">
      {/* Limit */}
      <form
        action={setTrialLimitAction}
        className="rounded-2xl border border-brand-charcoal/10 bg-white p-5"
      >
        <label htmlFor="limitUsd" className="block text-sm font-medium text-brand-charcoal">
          Trial limit (USD)
        </label>
        <p className="mt-1 text-sm text-brand-ink-soft">
          Chat hard-stops for everyone once estimated spend crosses this. Raise it to extend the
          trial.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <span className="text-brand-ink-soft">$</span>
          <input
            id="limitUsd"
            name="limitUsd"
            type="number"
            min="0"
            step="0.01"
            defaultValue={limitUsd.toFixed(2)}
            className="w-32 rounded-lg border border-brand-charcoal/20 px-3 py-1.5 text-sm tabular-nums text-brand-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
          />
          <button
            type="submit"
            className="rounded-lg bg-brand-charcoal px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-charcoal/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2"
          >
            Save limit
          </button>
        </div>
      </form>

      {/* On/off — the kill switch / removal lever */}
      <div className="flex items-center justify-between rounded-2xl border border-brand-charcoal/10 bg-white p-5">
        <div>
          <div className="text-sm font-medium text-brand-charcoal">
            Trial gate: {enabled ? "On" : "Off"}
          </div>
          <p className="mt-1 text-sm text-brand-ink-soft">
            {enabled
              ? "Enforcing the limit. Turn off to stop gating chat entirely (e.g. once they're on full billing)."
              : "Not enforcing — chat is unlimited regardless of spend."}
          </p>
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(() => setTrialEnabledAction(!enabled))}
          className="shrink-0 rounded-lg border border-brand-charcoal/20 px-4 py-1.5 text-sm font-medium text-brand-charcoal transition-colors hover:bg-brand-sand/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 disabled:opacity-50"
        >
          {pending ? "Saving…" : enabled ? "Turn off" : "Turn on"}
        </button>
      </div>
    </div>
  );
}
