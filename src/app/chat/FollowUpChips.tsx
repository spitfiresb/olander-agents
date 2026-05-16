"use client";

// Three locked follow-up prompts. They render under the last assistant
// message only (gated by the caller via showActions) so the chat stays
// quiet — older bubbles don't carry stale "Continue" affordances. Copy is
// deliberately literal: each click sends the prompt verbatim as the next
// user turn. No system-prompt magic, no client-side rewriting.
const FOLLOW_UPS: ReadonlyArray<{ label: string; prompt: string }> = [
  { label: "Shorter", prompt: "Make that response shorter and more direct." },
  {
    label: "Email-ready",
    prompt: "Reformat that as a short email I can send to a customer.",
  },
  { label: "Continue", prompt: "Continue." },
];

type Props = {
  onSelect: (prompt: string) => void;
};

export function FollowUpChips({ onSelect }: Props) {
  return (
    <div className="flex flex-wrap gap-2">
      {FOLLOW_UPS.map((f) => (
        <button
          key={f.label}
          type="button"
          onClick={() => onSelect(f.prompt)}
          className="inline-flex h-8 items-center rounded-full border border-brand-charcoal/15 bg-white px-3 text-xs font-medium text-brand-ink-soft transition-colors hover:border-brand-charcoal/30 hover:bg-brand-sand/40 hover:text-brand-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas"
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}
