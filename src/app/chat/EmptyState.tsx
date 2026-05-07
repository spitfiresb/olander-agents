"use client";

import { Logo } from "@/components/Logo";

const SUGGESTIONS = [
  "Look up customer ACME-1234",
  "Find part SKU 8501-22",
  "Open orders for ACME this month",
  "What can you do right now?",
];

export function EmptyState({
  onSelectSuggestion,
}: {
  onSelectSuggestion: (text: string) => void;
}) {
  return (
    <div className="flex flex-col items-center pb-8 pt-12 text-center sm:pt-20">
      <Logo size="md" />
      <h2 className="mt-6 text-2xl font-semibold tracking-tight text-brand-charcoal">
        How can I help today?
      </h2>
      <p className="mt-2 text-sm text-brand-ink-soft">
        Ask about customers, inventory, or open orders.
      </p>
      <div className="mt-8 grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((text) => (
          <button
            key={text}
            type="button"
            onClick={() => onSelectSuggestion(text)}
            className="rounded-full border border-brand-charcoal/15 bg-white px-4 py-2.5 text-left text-sm text-brand-charcoal transition-colors hover:border-brand-charcoal/30 hover:bg-brand-sand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas"
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
