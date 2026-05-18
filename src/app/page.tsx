import { Wordmark } from "@/components/Wordmark";
import { SignInPanel } from "./SignInPanel";

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
      <main className="relative flex flex-1 flex-col items-center justify-start px-6 pb-12 pt-[22vh]">
        <div className="mb-10 flex flex-col items-center text-center">
          <Wordmark variant="hero" />
        </div>

        <SignInPanel />
      </main>

      <footer className="relative px-6 py-4 text-center text-xs text-brand-ink-soft/60">
        © Olander Inc. — Internal tool
      </footer>
    </div>
  );
}
