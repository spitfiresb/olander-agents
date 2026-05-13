import { redirect, notFound } from "next/navigation";
import { auth } from "@/auth";
import { dailyUsage } from "@/lib/conversations";
import { BackLink } from "@/components/BackLink";

export const dynamic = "force-dynamic";

// Cached cost / 1M tokens. Pricing is Anthropic-public for Sonnet 4.6 at
// time of writing — verify when running, treat as informational.
const COST_INPUT_PER_M = 3;
const COST_CACHED_INPUT_PER_M = 0.3;
const COST_OUTPUT_PER_M = 15;

function estimateUsd(row: {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}): number {
  const fresh = row.inputTokens - row.cachedInputTokens;
  return (
    (Math.max(0, fresh) * COST_INPUT_PER_M +
      row.cachedInputTokens * COST_CACHED_INPUT_PER_M +
      row.outputTokens * COST_OUTPUT_PER_M) /
    1_000_000
  );
}

export default async function UsagePage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  if (session.user.role !== "admin") notFound();

  const rows = await dailyUsage(30);

  return (
    <div className="min-h-dvh bg-brand-canvas">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <BackLink href="/admin">Back to admin</BackLink>
        <h1 className="mt-4 text-2xl font-semibold text-brand-charcoal">Token usage</h1>
        <p className="mt-2 text-sm text-brand-ink-soft">
          Last 30 days of assistant turns, grouped by date. Cost estimates
          use Anthropic public pricing for Sonnet 4.6 at the time this page
          was built — check the Anthropic console for the authoritative
          number.
        </p>

        <div className="mt-6 overflow-hidden rounded-2xl border border-brand-charcoal/10 bg-white">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-brand-canvas/70 text-left text-xs uppercase tracking-wider text-brand-ink-soft">
              <tr>
                <th className="px-3 py-2 font-semibold">Day</th>
                <th className="px-3 py-2 text-right font-semibold">Messages</th>
                <th className="px-3 py-2 text-right font-semibold">Input</th>
                <th className="px-3 py-2 text-right font-semibold">Cached</th>
                <th className="px-3 py-2 text-right font-semibold">Output</th>
                <th className="px-3 py-2 text-right font-semibold">Est. $</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.day} className={i % 2 === 0 ? "bg-white" : "bg-brand-canvas/40"}>
                  <td className="px-3 py-2 align-top font-mono text-[12px] text-brand-charcoal">
                    {r.day}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.messages}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.inputTokens.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.cachedInputTokens.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.outputTokens.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {estimateUsd(r).toLocaleString(undefined, {
                      style: "currency",
                      currency: "USD",
                      minimumFractionDigits: 2,
                    })}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-sm text-brand-ink-soft">
                    No assistant turns recorded in the last 30 days.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
