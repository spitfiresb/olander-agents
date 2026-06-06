// Read-only spend summary for the TEMPORARY trial gate (see src/lib/trial.ts).
// Shown at the top of /admin. Pure render — no controls (the limit is set
// out-of-band; admins only watch what's left).

const usd = (n: number) =>
  n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });

export function TrialUsageSummary({
  trial,
}: {
  trial: {
    enabled: boolean;
    exhausted: boolean;
    spentUsd: number;
    limitUsd: number;
    remainingUsd: number;
  };
}) {
  const pct = trial.limitUsd > 0 ? Math.min(100, (trial.spentUsd / trial.limitUsd) * 100) : 0;
  return (
    <div className="rounded-2xl border border-brand-charcoal/10 bg-white p-5">
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-brand-ink-soft">Trial spend</span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            !trial.enabled
              ? "bg-brand-charcoal/10 text-brand-ink-soft"
              : trial.exhausted
                ? "bg-brand-red/10 text-brand-red"
                : "bg-brand-sand/60 text-brand-charcoal"
          }`}
        >
          {!trial.enabled ? "Gate off" : trial.exhausted ? "Limit reached" : "Active"}
        </span>
      </div>
      <div className="mt-2 text-3xl font-semibold tabular-nums text-brand-charcoal">
        {usd(trial.spentUsd)}{" "}
        <span className="text-lg font-normal text-brand-ink-soft">/ {usd(trial.limitUsd)}</span>
      </div>
      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-brand-charcoal/10">
        <div
          className={`h-full rounded-full ${trial.exhausted ? "bg-brand-red" : "bg-brand-charcoal/50"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-2 text-sm text-brand-ink-soft">{usd(trial.remainingUsd)} remaining</div>
    </div>
  );
}
