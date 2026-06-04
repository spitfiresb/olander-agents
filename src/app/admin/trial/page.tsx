import { redirect, notFound } from "next/navigation";
import { auth } from "@/auth";
import { BackLink } from "@/components/BackLink";
import { getTrialStatus } from "@/lib/trial";
import { TrialControls } from "./TrialControls";

export const dynamic = "force-dynamic";

const usd = (n: number) =>
  n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });

export default async function TrialPage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  if (session.user.role !== "admin") notFound();

  const trial = await getTrialStatus();
  const pct = trial.limitUsd > 0 ? Math.min(100, (trial.spentUsd / trial.limitUsd) * 100) : 0;

  return (
    <div className="min-h-dvh bg-brand-canvas">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <BackLink href="/admin">Back to admin</BackLink>
        <h1 className="mt-4 text-2xl font-semibold text-brand-charcoal">Trial spend gate</h1>
        <p className="mt-2 text-sm text-brand-ink-soft">
          Temporary deployment-wide trial allowance. Once estimated spend crosses the limit, chat
          hard-stops for <strong>everyone</strong> — this admin page stays reachable so you can
          raise the limit or turn the gate off. Spend is an in-app estimate from token usage priced
          per model, so it trips <em>near</em> the limit, not to the exact cent.
        </p>

        {/* Spend summary */}
        <div className="mt-6 rounded-2xl border border-brand-charcoal/10 bg-white p-5">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-brand-ink-soft">Estimated spend</span>
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

        <TrialControls enabled={trial.enabled} limitUsd={trial.limitUsd} />
      </div>
    </div>
  );
}
