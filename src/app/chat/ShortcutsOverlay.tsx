"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { CloseIcon } from "@/components/icons";

type Props = {
  open: boolean;
  onClose: () => void;
};

// Mac vs non-Mac modifier label. useSyncExternalStore keeps this SSR-safe
// (server snapshot is "Ctrl", which matches the not-yet-detected client
// render; the snapshot re-reads after hydration and updates the dialog
// content cleanly).
const subscribeNoop = () => () => {};
const detectMod = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent)
    ? "⌘"
    : "Ctrl";
const serverMod = () => "Ctrl";

type Shortcut = { keys: ReadonlyArray<string>; label: string };

export function ShortcutsOverlay({ open, onClose }: Props) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const mod = useSyncExternalStore(subscribeNoop, detectMod, serverMod);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    closeButtonRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  const shortcuts: ReadonlyArray<Shortcut> = [
    { keys: [mod, "K"], label: "New chat" },
    { keys: [mod, "/"], label: "Focus composer" },
    { keys: [mod, "Shift", "C"], label: "Copy latest reply" },
    { keys: ["Esc"], label: "Stop generating" },
    { keys: ["?"], label: "Show this menu" },
  ];

  return (
    <div
      className={`fixed inset-0 z-40 flex items-center justify-center px-4 ${
        open ? "pointer-events-auto" : "pointer-events-none"
      }`}
      // `inert` is the modern replacement for aria-hidden on a closed dialog
      // container — removes descendants from the focus order entirely, so the
      // close button can't retain focus while its ancestor claims to be
      // hidden (which the browser correctly warns about with aria-hidden).
      // Spec: https://html.spec.whatwg.org/multipage/interaction.html#inert
      inert={!open}
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close keyboard shortcuts"
        tabIndex={open ? 0 : -1}
        onClick={onClose}
        className={`absolute inset-0 bg-brand-charcoal/40 transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />

      {/* Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-overlay-title"
        className={`relative w-full max-w-md rounded-2xl bg-white p-6 shadow-xl transition-all duration-200 ease-out ${
          open ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
        }`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2
            id="shortcuts-overlay-title"
            className="text-sm font-semibold text-brand-charcoal"
          >
            Keyboard shortcuts
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
            className="flex h-8 w-8 items-center justify-center rounded-md text-brand-ink-soft transition-colors hover:bg-brand-sand/40 hover:text-brand-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2"
          >
            <CloseIcon />
          </button>
        </div>
        <ul className="flex flex-col gap-2">
          {shortcuts.map((s) => (
            <li
              key={s.label}
              className="flex items-center justify-between gap-4 text-sm text-brand-charcoal"
            >
              <span>{s.label}</span>
              <span className="flex items-center gap-1">
                {s.keys.map((k, i) => (
                  <kbd
                    key={`${s.label}-${i}`}
                    className="inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded border border-brand-charcoal/15 bg-brand-sand/40 px-1.5 font-mono text-[11px] text-brand-charcoal"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
