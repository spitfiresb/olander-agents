import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";

export default async function HelpPage() {
  const session = await auth();
  if (!session?.user) redirect("/");

  return (
    <div className="min-h-dvh bg-brand-canvas">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <Link
          href="/chat"
          className="text-sm text-brand-red hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas"
        >
          ← Back to chat
        </Link>

        <h1 className="mt-6 text-2xl font-semibold text-brand-charcoal">
          Help
        </h1>
        <p className="mt-2 text-sm text-brand-ink-soft">
          Olander Agents is a fast lookup tool for the parts, customers,
          inventory, and orders you work with every day. Below: what it
          does, what it doesn&rsquo;t, and who to call when it&rsquo;s broken.
        </p>

        <section className="mt-8">
          <h2 className="text-base font-semibold text-brand-charcoal">
            What you can ask
          </h2>
          <ul className="mt-2 space-y-1.5 text-sm text-brand-charcoal">
            <li>Inventory: &ldquo;Do we have any M10 1.25 socket head cap screws in stock?&rdquo;</li>
            <li>Catalog: &ldquo;What size helicoil goes in a 3/8-16 hole?&rdquo;</li>
            <li>Customer history: &ldquo;Last 10 orders for ACME this month.&rdquo;</li>
            <li>Vendor sourcing: &ldquo;Who carries bronze cap screws?&rdquo;</li>
            <li>Marketing lists: &ldquo;Stainless customers who haven&rsquo;t ordered in 90 days.&rdquo;</li>
          </ul>
        </section>

        <section className="mt-8">
          <h2 className="text-base font-semibold text-brand-charcoal">
            Where the answers come from
          </h2>
          <p className="mt-2 text-sm text-brand-charcoal">
            Questions about parts, customers, and orders are answered
            directly from P21 through a read-only proxy. Catalog and spec
            questions are answered from a small reference library inside
            the system prompt. Tool-call cards show exactly which view or
            record the answer used.
          </p>
        </section>

        <section className="mt-8">
          <h2 className="text-base font-semibold text-brand-charcoal">
            What it doesn&rsquo;t do (yet)
          </h2>
          <ul className="mt-2 space-y-1.5 text-sm text-brand-charcoal">
            <li>Write to P21 (create orders, quotes, edits). All access is read-only.</li>
            <li>Upload files or parse PDFs.</li>
            <li>Voice input or image search.</li>
          </ul>
        </section>

        <section className="mt-8">
          <h2 className="text-base font-semibold text-brand-charcoal">
            Keyboard shortcuts
          </h2>
          <ul className="mt-2 space-y-1.5 text-sm text-brand-charcoal">
            <li><Kbd>⌘</Kbd> <Kbd>K</Kbd> — start a new chat</li>
            <li><Kbd>⌘</Kbd> <Kbd>/</Kbd> — focus the composer</li>
            <li><Kbd>⌘</Kbd> <Kbd>⇧</Kbd> <Kbd>C</Kbd> — copy the latest assistant reply</li>
            <li><Kbd>Esc</Kbd> — stop generating</li>
          </ul>
        </section>

        <section className="mt-8 rounded-2xl border border-brand-charcoal/10 bg-white px-5 py-4 text-sm text-brand-charcoal">
          <p className="font-semibold">When it&rsquo;s broken</p>
          <p className="mt-1 text-brand-ink-soft">
            Check the <Link href="/status" className="text-brand-red underline underline-offset-2">status page</Link> first. If the P21
            row is red, email Olander IT. For other issues, see
            <code className="ml-1 rounded bg-brand-sand/40 px-1">docs/Runbook.md</code>.
          </p>
        </section>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-brand-charcoal/15 bg-white px-1.5 font-mono text-[11px] text-brand-charcoal">
      {children}
    </kbd>
  );
}
