"use client";

import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";

// Styled size picker matching the app's TierDropdown: a gray-outlined box
// showing "<n> MB"; click for an animated panel of options portaled to <body>
// (fixed-positioned so it overlays without reflow and isn't clipped).
export function SizeDropdown({
  value,
  options,
  onChange,
  disabled,
}: {
  value: number;
  options: number[];
  onChange: (mb: number) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left, width: r.width });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    }
    function close() {
      setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  return (
    <span className="inline-block">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex w-40 items-center justify-between gap-1.5 rounded-md border border-brand-charcoal/15 bg-white px-3 py-1.5 text-sm text-brand-charcoal transition-colors hover:border-brand-charcoal/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-brand-charcoal/15"
      >
        <span>{value} MB</span>
        <Chevron open={open} />
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              role="listbox"
              className="animate-menu-in fixed z-50 overflow-hidden rounded-md border border-brand-charcoal/10 bg-white py-1 shadow-md"
              style={{ top: pos.top, left: pos.left, minWidth: pos.width }}
            >
              {options.map((opt) => {
                const active = opt === value;
                return (
                  <button
                    key={opt}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      onChange(opt);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm transition-colors hover:bg-brand-sand/40 focus-visible:bg-brand-sand/40 focus-visible:outline-none ${
                      active ? "font-medium text-brand-charcoal" : "text-brand-ink-soft"
                    }`}
                  >
                    <span>{opt} MB</span>
                    {active ? <Check /> : <span className="w-3" aria-hidden />}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`shrink-0 text-brand-ink-soft transition-transform duration-150 ${open ? "rotate-180" : ""}`}
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function Check() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0 text-brand-charcoal"
    >
      <path d="M3 8.5l3.5 3.5L13 4.5" />
    </svg>
  );
}
