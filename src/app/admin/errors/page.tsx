import { redirect, notFound } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/db";
import { chatErrors, users } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { BackLink } from "@/components/BackLink";

export const dynamic = "force-dynamic";

// Per-request failure log. Complements /status (infra-level health) by recording
// WHICH query hit WHAT error — the evidence behind a "Something went wrong"
// report. Admin-only; raw error text lives here on purpose (see schema.ts).
export default async function ErrorsPage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  if (session.user.role !== "admin") notFound();

  const rows = await db
    .select({
      id: chatErrors.id,
      createdAt: chatErrors.createdAt,
      phase: chatErrors.phase,
      code: chatErrors.code,
      errorMessage: chatErrors.errorMessage,
      provider: chatErrors.provider,
      model: chatErrors.model,
      query: chatErrors.query,
      toolCallCount: chatErrors.toolCallCount,
      userEmail: users.email,
    })
    .from(chatErrors)
    .leftJoin(users, eq(users.id, chatErrors.userId))
    .orderBy(desc(chatErrors.createdAt))
    .limit(200);

  return (
    <div className="min-h-dvh bg-brand-canvas">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <BackLink href="/admin">Back to admin</BackLink>
        <h1 className="mt-4 text-2xl font-semibold text-brand-charcoal">Chat errors</h1>
        <p className="mt-2 text-sm text-brand-ink-soft">
          Last 200 failed chat turns. Each row is a turn the user saw fail (or
          come back blank): the query, the raw provider error, and how many tool
          calls ran first. This is the per-request detail the{" "}
          <a href="/status" className="underline">status page</a> can&apos;t
          show. Empty is good.
        </p>

        {rows.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-brand-charcoal/10 bg-white px-4 py-8 text-center text-sm text-brand-ink-soft">
            No chat errors recorded. 🎉
          </div>
        ) : (
          <div className="mt-6 overflow-hidden rounded-2xl border border-brand-charcoal/10 bg-white">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-brand-canvas/70 text-left text-xs uppercase tracking-wider text-brand-ink-soft">
                <tr>
                  <th className="px-3 py-2 font-semibold">When</th>
                  <th className="px-3 py-2 font-semibold">User</th>
                  <th className="px-3 py-2 font-semibold">Phase</th>
                  <th className="px-3 py-2 font-semibold">Code</th>
                  <th className="px-3 py-2 font-semibold">Query</th>
                  <th className="px-3 py-2 font-semibold">Error</th>
                  <th className="px-3 py-2 font-semibold">Model</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={row.id} className={i % 2 === 0 ? "bg-white" : "bg-brand-canvas/40"}>
                    <td className="px-3 py-2 align-top font-mono text-[12px] whitespace-nowrap text-brand-ink-soft">
                      {new Date(row.createdAt).toISOString().replace("T", " ").slice(0, 19)}
                    </td>
                    <td className="px-3 py-2 align-top text-brand-charcoal">
                      {row.userEmail ?? "—"}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <PhaseBadge phase={row.phase} />
                    </td>
                    <td className="px-3 py-2 align-top font-mono text-[12px] text-brand-charcoal">
                      {row.code ?? "—"}
                      {row.toolCallCount != null && row.toolCallCount > 0 && (
                        <span className="ml-1 text-brand-ink-soft">
                          · {row.toolCallCount} tool{row.toolCallCount === 1 ? "" : "s"}
                        </span>
                      )}
                    </td>
                    <td className="max-w-[18rem] px-3 py-2 align-top text-[13px] text-brand-charcoal">
                      <span className="line-clamp-3 break-words">{row.query ?? "—"}</span>
                    </td>
                    <td className="max-w-[22rem] px-3 py-2 align-top font-mono text-[11px] text-brand-ink-soft">
                      <span className="line-clamp-4 break-words">{row.errorMessage ?? "—"}</span>
                    </td>
                    <td className="px-3 py-2 align-top font-mono text-[11px] whitespace-nowrap text-brand-ink-soft">
                      {row.model ?? row.provider ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function PhaseBadge({ phase }: { phase: string }) {
  // 'blank_answer' is the soft case (no exception, just no text); the rest are
  // real errors. Tint accordingly so the eye separates "broke" from "empty".
  const soft = phase === "blank_answer";
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
        soft
          ? "bg-amber-500/10 text-amber-700"
          : "bg-brand-red/10 text-brand-red"
      }`}
    >
      {phase}
    </span>
  );
}
