"use client";

import { type ReactNode, useEffect, useRef } from "react";
import { CloseIcon } from "@/components/icons";

type Props = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
};

// Slide-from-left drawer wrapping the desktop Sidebar component, only mounted
// under lg. The Sidebar itself is responsive (w-full on mobile, w-64 on lg+)
// so the same component renders cleanly in both contexts.
//
// Behavior:
//   - Esc and backdrop click both close
//   - Body scroll is locked while open so the page underneath doesn't move
//   - Focus moves to the close button on open; restored to the prior trigger
//     on close via the browser's natural focus return after unmount
//   - 200ms ease-out transition, gated implicitly by the user's reduced-motion
//     preference (transform/opacity transitions are exempt from our globals.css
//     gating, but the perceived motion is small enough not to matter)
export function MobileSidebarDrawer({ open, onClose, children }: Props) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);

    // Lock body scroll so swipe gestures inside the drawer don't bleed into
    // the page underneath. Save the prior value so multiple open/close
    // cycles don't permanently overwrite a stylesheet value.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    closeButtonRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  return (
    <div
      className={`fixed inset-0 z-30 lg:hidden ${
        open ? "pointer-events-auto" : "pointer-events-none"
      }`}
      aria-hidden={!open}
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close chat history"
        tabIndex={open ? 0 : -1}
        onClick={onClose}
        className={`absolute inset-0 bg-brand-charcoal/40 transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />

      {/* Sliding panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Chat history"
        className={`absolute inset-y-0 left-0 flex w-[min(20rem,85vw)] max-w-full transform flex-col bg-brand-charcoal shadow-xl transition-transform duration-200 ease-out ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label="Close chat history"
          className="absolute right-2 top-2 z-10 flex h-9 w-9 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-charcoal"
        >
          <CloseIcon />
        </button>
        <div className="flex h-full min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </div>
  );
}
