import Link from "next/link";
import { Wordmark } from "@/components/Wordmark";

type ErrorCopy = { title: string; body: string };

// Copy is intentionally high-level: it confirms what stage failed (so a
// legitimate user knows whether retrying will help) without revealing the
// specific authorization rule (tenant ID, allowed domain, etc.) that
// rejected them.
function copyForError(code: string | undefined): ErrorCopy {
  switch (code) {
    case "AccessDenied":
      return {
        title: "Account not authorized",
        body: "Your account doesn't have access to this application.",
      };
    case "Configuration":
      return {
        title: "Sign-in unavailable",
        body: "Sign-in is temporarily unavailable. Please contact IT.",
      };
    case "Verification":
      return {
        title: "Sign-in link expired",
        body: "This sign-in link is no longer valid. Please try again.",
      };
    default:
      return {
        title: "Sign-in unsuccessful",
        body: "We couldn't sign you in. Please try again.",
      };
  }
}

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const { title, body } = copyForError(error);

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
      <main className="relative flex flex-1 flex-col items-center justify-start px-6 pb-12 pt-[18vh]">
        <div className="mb-10 flex flex-col items-center text-center">
          <Wordmark variant="hero" />
        </div>

        <div className="w-full max-w-sm rounded-2xl border border-brand-charcoal/10 bg-white p-7 shadow-[0_8px_32px_-12px_rgba(45,46,41,0.12)]">
          <h1 className="text-lg font-semibold text-brand-charcoal">{title}</h1>
          <p className="mt-2 text-sm text-brand-ink-soft">{body}</p>

          <Link
            href="/"
            className="mt-6 flex h-11 w-full items-center justify-center rounded-md bg-brand-red px-6 text-sm font-medium text-white transition-colors hover:bg-brand-red/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2"
          >
            Back to login
          </Link>
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
