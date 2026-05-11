import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { auth } from "@/auth";

export default async function AdminPage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  if (session.user.role !== "admin") notFound();

  return (
    <div className="min-h-dvh bg-brand-canvas">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-semibold text-brand-charcoal">Admin</h1>
        <p className="mt-2 text-sm text-brand-ink-soft">
          Operational views. Visible only to accounts with the{" "}
          <code className="font-mono text-[12px]">admin</code> role.
        </p>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Link
            href="/admin/audit"
            className="block rounded-2xl border border-brand-charcoal/10 bg-white p-5 transition-colors hover:border-brand-charcoal/30 hover:bg-brand-sand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
          >
            <div className="text-base font-medium text-brand-charcoal">
              Tool-call audit
            </div>
            <div className="mt-1 text-sm text-brand-ink-soft">
              Last 200 tool calls across all users — view name, filter, errors.
            </div>
          </Link>

          <Link
            href="/admin/usage"
            className="block rounded-2xl border border-brand-charcoal/10 bg-white p-5 transition-colors hover:border-brand-charcoal/30 hover:bg-brand-sand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
          >
            <div className="text-base font-medium text-brand-charcoal">
              Usage &amp; cost
            </div>
            <div className="mt-1 text-sm text-brand-ink-soft">
              30-day token rollup and estimated Anthropic spend.
            </div>
          </Link>
        </div>

        <div className="mt-8">
          <Link
            href="/chat"
            className="text-sm text-brand-ink-soft underline-offset-2 hover:underline"
          >
            ← Back to chat
          </Link>
        </div>
      </div>
    </div>
  );
}
