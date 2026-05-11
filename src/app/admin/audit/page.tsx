import { redirect, notFound } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/db";
import { toolCalls, users } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  if (session.user.role !== "admin") notFound();

  const rows = await db
    .select({
      id: toolCalls.id,
      createdAt: toolCalls.createdAt,
      toolName: toolCalls.toolName,
      args: toolCalls.args,
      errorCode: toolCalls.errorCode,
      durationMs: toolCalls.durationMs,
      userEmail: users.email,
    })
    .from(toolCalls)
    .leftJoin(users, eq(users.id, toolCalls.userId))
    .orderBy(desc(toolCalls.createdAt))
    .limit(200);

  return (
    <div className="min-h-dvh bg-brand-canvas">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="text-2xl font-semibold text-brand-charcoal">Tool-call audit</h1>
        <p className="mt-2 text-sm text-brand-ink-soft">
          Last 200 tool calls. Args column is the filter / id used; result
          payloads are not echoed here (they can be large).
        </p>

        <div className="mt-6 overflow-hidden rounded-2xl border border-brand-charcoal/10 bg-white">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-brand-canvas/70 text-left text-xs uppercase tracking-wider text-brand-ink-soft">
              <tr>
                <th className="px-3 py-2 font-semibold">When</th>
                <th className="px-3 py-2 font-semibold">User</th>
                <th className="px-3 py-2 font-semibold">Tool</th>
                <th className="px-3 py-2 font-semibold">Args</th>
                <th className="px-3 py-2 font-semibold">Error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.id} className={i % 2 === 0 ? "bg-white" : "bg-brand-canvas/40"}>
                  <td className="px-3 py-2 align-top font-mono text-[12px] text-brand-ink-soft">
                    {new Date(row.createdAt).toISOString().replace("T", " ").slice(0, 19)}
                  </td>
                  <td className="px-3 py-2 align-top text-brand-charcoal">
                    {row.userEmail ?? "—"}
                  </td>
                  <td className="px-3 py-2 align-top font-mono text-[12px] text-brand-charcoal">
                    {row.toolName}
                  </td>
                  <td className="px-3 py-2 align-top font-mono text-[12px] text-brand-charcoal">
                    {summarizeArgs(row.args)}
                  </td>
                  <td className="px-3 py-2 align-top text-brand-ink-soft">
                    {row.errorCode ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "—";
  const a = args as {
    viewName?: string;
    filter?: string;
    area?: string;
    resource?: string;
    id?: string;
  };
  if (a.viewName) {
    return `${a.viewName}${a.filter ? `  ${a.filter}` : ""}`;
  }
  if (a.id) {
    return `${a.area ?? "?"} / ${a.resource ?? "?"} / ${a.id}`;
  }
  return JSON.stringify(args).slice(0, 80);
}
