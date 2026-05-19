"use client";

import { Logo } from "@/components/Logo";
import { RecentChatsGrid } from "./RecentChatsGrid";
import type { ConversationSummary } from "./Sidebar";

const SUGGESTIONS = [
  "What size helicoil goes in a 3/8-16 hole?",
  "Do we have any M10 1.25 socket head cap screws in stock?",
  "Stainless customers who haven't ordered in 90 days",
  "Who carries bronze cap screws?",
];

type Props = {
  onSelectSuggestion: (text: string) => void;
  conversations: ConversationSummary[];
};

// Two surfaces, one component. New-user (zero history) keeps today's
// onboarding view verbatim — logo + greeting + four suggestion chips —
// because the cold-start path is on-brand and we haven't earned the
// right to clutter it yet. Returning rep gets the warm-start view:
// six most-recent chats as cards above, suggestion chips as a fallback
// below. Branch happens on a single conversations.length check.
//
// Cold-start polish is on the Stage 5 list — flagged 2026-05-19 as
// "could be improved" but not part of 4b scope; revisit alongside
// other chrome polish.
export function EmptyState({ onSelectSuggestion, conversations }: Props) {
  if (conversations.length === 0) {
    return <ColdStartView onSelectSuggestion={onSelectSuggestion} />;
  }
  return (
    <WarmStartView
      conversations={conversations}
      onSelectSuggestion={onSelectSuggestion}
    />
  );
}

function ColdStartView({
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

function WarmStartView({
  conversations,
  onSelectSuggestion,
}: {
  conversations: ConversationSummary[];
  onSelectSuggestion: (text: string) => void;
}) {
  return (
    <div className="pb-8 pt-8 sm:pt-12">
      <div className="flex justify-center">
        <Logo size="md" />
      </div>
      <section className="mt-8">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-brand-ink-soft">
          Recent
        </h3>
        <RecentChatsGrid conversations={conversations} />
      </section>
      <section className="mt-8">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-brand-ink-soft">
          Or try
        </h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {SUGGESTIONS.map((text) => (
            <SuggestionButton
              key={text}
              text={text}
              onSelect={onSelectSuggestion}
            />
          ))}
        </div>
      </section>
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
