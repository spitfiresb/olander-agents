"use client";

import { useEffect, useState } from "react";
import { Logo } from "@/components/Logo";

// Curated suggestion pool. Every entry was audited against live P21 data
// via the droplet proxy + Qdrant catalog: each one returns a substantive,
// demo-worthy result today. Specific choices that took data to settle:
//   - "31C100SHCS" (5/16-18 X 1 SOC CAP SST) — has multi-warehouse stock
//     (2,265 at HQ + 183 elsewhere), so "across all warehouses" actually
//     shows a spread. PN12345-01 from the system-prompt examples comes back
//     0 everywhere and reads as a dead demo.
//   - "last 30 days" and "last 6 months" windows instead of "today" /
//     "this month" — P21's most-recent activity in our test dataset trails
//     the calendar by 1-2 weeks; narrower windows risked 0-row results.
//
// No aggregation-only prompts (the viewsQuery tool has no $apply/groupby).
// No price-bearing prompts (the `pricing` scope is opt-in for non-admins).
const SUGGESTION_POOL = [
  "What size helicoil goes in a 3/8-16 hole?",
  "Do we have any M10 1.25 socket head cap screws in stock?",
  "What parts do we stock the most of?",
  "Who carries bronze cap screws?",
  "On-hand for 31C100SHCS across all warehouses",
  "Find a 5/16-18 stainless flange nut",
  "Stock check on 1/4-20 stainless lock nuts",
  "Open sales orders shipping this week",
  "Open POs landing in the next 14 days",
  "Past-due invoices from the last 6 months",
  "Open sales orders from the last 30 days",
  "Customers added in the last 30 days",
] as const;

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
