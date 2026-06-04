// TEMPORARY trial-gate UI. The running usage display lives on /admin now (not in
// the chat). The only chat-facing piece is TrialBlocked, which replaces the
// composer once the allowance is spent. Fed by server-computed trial status
// (see src/lib/trial.ts), threaded through ChatShell.

// Client-facing slice of TrialStatus — only what the chat needs, so we don't
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
