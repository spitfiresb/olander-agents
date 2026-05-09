import { Wordmark } from "@/components/Wordmark";

export default function Home() {
  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-brand-canvas">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-2/3"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 50% 0%, rgba(228, 217, 197, 0.55) 0%, transparent 70%)",
        }}
      />
      <main className="relative flex flex-1 flex-col items-center justify-center px-6 py-12">
        <div className="mb-10 flex flex-col items-center text-center">
          <Wordmark variant="hero" />
          <p className="mt-4 max-w-sm text-sm text-brand-ink-soft sm:text-base">
            Internal AI assistant for fastener teams. Ask about customers,
            inventory, and orders.
          </p>
        </div>

        <div className="w-full max-w-sm rounded-2xl border border-brand-charcoal/10 bg-white p-7 shadow-[0_8px_32px_-12px_rgba(45,46,41,0.12)]">
          <h1 className="text-xl font-semibold tracking-tight text-brand-charcoal">
            Sign in
          </h1>
          <p className="mt-1.5 text-sm text-brand-ink-soft">
            Continue with your Olander Microsoft account.
          </p>
          {/* Auth not wired yet; CTA bypasses straight to the chat. */}
          <a
            href="/chat"
            className="mt-6 flex h-11 items-center justify-center rounded-md bg-brand-red px-6 text-sm font-medium text-white transition-colors hover:bg-brand-red/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2"
          >
            Sign in with Microsoft
          </a>
          <div className="mt-5 flex items-center gap-2 text-xs text-brand-ink-soft">
            <LockIcon />
            Internal use — authorized employees only.
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-brand-ink-soft">
          Need help signing in?{" "}
          <a
            href="mailto:support@example.com"
            className="font-medium text-brand-charcoal underline-offset-2 transition-colors hover:text-brand-red hover:underline"
          >
            Contact IT
          </a>
        </p>
      </main>

      <footer className="relative px-6 py-4 text-center text-xs text-brand-ink-soft/60">
        © Olander Inc. — Internal tool
      </footer>
    </div>
  );
}

function LockIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
    >
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V4.5a2.5 2.5 0 0 1 5 0V7" />
    </svg>
  );
}
