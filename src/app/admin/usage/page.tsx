import { redirect, notFound } from "next/navigation";
import { auth } from "@/auth";
import { dailyUsage } from "@/lib/conversations";
import { estimateUsd } from "@/lib/ai/pricing";
import { BackLink } from "@/components/BackLink";

export const dynamic = "force-dynamic";

type DayRow = {
  day: string;
  messages: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  estUsd: number;
};

// Roll the per-(day, model) rows from dailyUsage up into one row per day,
// pricing each model bucket at its own rate (see lib/ai/pricing.ts) before
// summing — so a day that mixes Sonnet and GPT-5 turns is costed correctly.
function rollUpByDay(
  rows: Awaited<ReturnType<typeof dailyUsage>>,
): DayRow[] {
  const byDay = new Map<string, DayRow>();
  for (const r of rows) {
    const d = byDay.get(r.day) ?? {
      day: r.day,
      messages: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      estUsd: 0,
    };
    d.messages += r.messages;
    d.inputTokens += r.inputTokens;
    d.cachedInputTokens += r.cachedInputTokens;
    d.outputTokens += r.outputTokens;
    d.estUsd += estimateUsd(r.model, r);
    byDay.set(r.day, d);
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}

export default async function UsagePage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  if (session.user.role !== "admin") notFound();

  const rows = rollUpByDay(await dailyUsage(30));

  return (
    <div className="min-h-dvh bg-brand-canvas">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <BackLink href="/admin">Back to admin</BackLink>
        <h1 className="mt-4 text-2xl font-semibold text-brand-charcoal">Token usage</h1>
        <p className="mt-2 text-sm text-brand-ink-soft">
          Last 30 days of assistant turns, grouped by date. Cost estimates price
          each turn at its own model&apos;s public rate (see{" "}
          <code className="font-mono text-[12px]">lib/ai/pricing.ts</code>) — check
          the provider console for the authoritative number.
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
                    {r.estUsd.toLocaleString(undefined, {
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
