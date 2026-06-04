"use client";

import { useEffect, useState } from "react";
import { Logo } from "@/components/Logo";
import { SUGGESTION_POOL } from "@/lib/suggestions";

const VISIBLE_COUNT = 4;

type Props = {
  onSelectSuggestion: (text: string) => void;
};

// One surface: logo + greeting + four suggestion chips. The earlier
// warm-start variant (recent-chat cards + Or-try chips) was pulled —
// the sidebar already covers chat history, so the cards just doubled
// the same titles and pushed the greeting off-screen.
export function EmptyState({ onSelectSuggestion }: Props) {
  // SSR-safe rotation: render a deterministic prefix on first paint so
  // server HTML matches client hydration, then shuffle on mount. Math.random
  // in the lazy initializer would diverge between server and client and
  // throw a hydration warning.
  const [suggestions, setSuggestions] = useState<readonly string[]>(() =>
    SUGGESTION_POOL.slice(0, VISIBLE_COUNT),
  );
  useEffect(() => {
    setSuggestions(pickRandom(SUGGESTION_POOL, VISIBLE_COUNT));
  }, []);

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
        {suggestions.map((text) => (
          <SuggestionButton
            key={text}
            text={text}
            onSelect={onSelectSuggestion}
          />
        ))}
      </div>
    </div>
  );
}

function SuggestionButton({
  text,
  onSelect,
}: {
  text: string;
  onSelect: (text: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(text)}
      className="rounded-full border border-brand-charcoal/15 bg-white px-4 py-2.5 text-left text-sm text-brand-charcoal transition-colors hover:border-brand-charcoal/30 hover:bg-brand-sand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas"
    >
      {text}
    </button>
  );
}

function pickRandom<T>(arr: readonly T[], n: number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, n);
}
