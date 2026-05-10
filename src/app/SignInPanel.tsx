"use client";

import { useState } from "react";
import { signInWithMicrosoft } from "./actions";

export function SignInPanel() {
  const [open, setOpen] = useState(false);

  return (
    <div className="w-full max-w-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="sign-in-panel"
        className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-brand-red px-6 text-sm font-medium text-white transition-colors hover:bg-brand-red/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2"
      >
        Sign in
        <ChevronDownIcon open={open} />
      </button>

      <div
        id="sign-in-panel"
        aria-hidden={!open}
        className="overflow-hidden transition-[max-height,margin-top] duration-[700ms] ease-in-out motion-reduce:transition-none"
        style={{
          maxHeight: open ? "260px" : "0",
          marginTop: open ? "0.75rem" : "0",
        }}
      >
        <div className="rounded-2xl border border-brand-charcoal/10 bg-white p-7 shadow-[0_8px_32px_-12px_rgba(45,46,41,0.12)]">
          <p className="text-sm text-brand-ink-soft">
            Continue with your Olander Microsoft account.
          </p>
          <form action={signInWithMicrosoft}>
            <button
              type="submit"
              tabIndex={open ? 0 : -1}
              className="mt-5 flex h-11 w-full items-center justify-center rounded-md bg-brand-red px-6 text-sm font-medium text-white transition-colors hover:bg-brand-red/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2"
            >
              Sign in with Microsoft
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function ChevronDownIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

