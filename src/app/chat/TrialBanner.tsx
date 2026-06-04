// TEMPORARY trial-gate UI. Two states, both fed by server-computed trial
// status (see src/lib/trial.ts), threaded through ChatShell:
//   - TrialBanner: slim always-on bar while the trial is active, so it's
//     unmistakable the client is on a temporary trial allowance.
//   - TrialBlocked: replaces the composer once the allowance is spent.
// Delete this file (and its two usages in ChatShell) to retire the feature.

// Client-facing slice of TrialStatus — only what the banner needs, so we don't
// ship the admin-only fields (updatedBy/updatedAt) to every user.
export type TrialBannerData = {
  enabled: boolean;
  exhausted: boolean;
  spentUsd: number;
  limitUsd: number;
  remainingUsd: number;
};

const usd = (n: number) =>
  n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });

export function TrialBanner({ trial }: { trial: TrialBannerData }) {
  const pct = trial.limitUsd > 0 ? Math.min(100, (trial.spentUsd / trial.limitUsd) * 100) : 0;
  return (
    <div className="mx-auto mt-2 w-full max-w-3xl px-4 sm:px-0">
      <div className="rounded-lg border border-brand-charcoal/15 bg-brand-sand/50 px-4 py-2.5 text-xs text-brand-charcoal">
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium">
            Trial mode · {usd(trial.spentUsd)} of {usd(trial.limitUsd)} used
          </span>
          <span className="shrink-0 text-brand-ink-soft">{usd(trial.remainingUsd)} left</span>
        </div>
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-brand-charcoal/10">
          <div className="h-full rounded-full bg-brand-charcoal/50" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1.5 text-brand-ink-soft">
          This is a temporary trial allowance — afterward your account moves to full billing.
        </p>
      </div>
    </div>
  );
}

export function TrialBlocked({ trial }: { trial: TrialBannerData }) {
  return (
    <div className="shrink-0 bg-brand-canvas">
      <div className="mx-auto max-w-3xl px-4 pb-6 pt-2 sm:px-6">
        <div className="rounded-2xl border border-brand-charcoal/15 bg-brand-sand/40 px-5 py-5 text-center">
          <h2 className="text-base font-semibold text-brand-charcoal">Trial limit reached</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-brand-ink-soft">
            You&apos;ve used the full {usd(trial.limitUsd)} trial allowance. This was a temporary
            trial to let you explore the assistant. To keep going, we&apos;ll set your account up on
            full billing — please reach out to continue.
          </p>
        </div>
      </div>
    </div>
  );
}
