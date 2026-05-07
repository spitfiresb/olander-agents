"use client";

import { type FormEvent, type KeyboardEvent } from "react";
import type { ChatStatus } from "ai";

type Props = {
  input: string;
  setInput: (value: string) => void;
  status: ChatStatus;
  error: Error | undefined;
  onSubmit: (text: string) => void;
  onStop: () => void;
  onRegenerate: () => void;
};

function friendlyErrorMessage(error: Error): string {
  const msg = error.message ?? "";
  if (msg.includes("server_misconfigured"))
    return "AI service isn't configured yet. Please contact your admin.";
  if (msg.includes("provider_auth"))
    return "AI provider rejected credentials. Please contact your admin.";
  if (msg.includes("rate_limited"))
    return "AI is busy right now. Try again in a moment.";
  if (msg.includes("provider_unavailable"))
    return "AI service is temporarily unavailable. Try again shortly.";
  if (msg.includes("bad_request"))
    return "Couldn't send your message. Please refresh and try again.";
  return "Something went wrong. Please try again.";
}

export function Composer({
  input,
  setInput,
  status,
  error,
  onSubmit,
  onStop,
  onRegenerate,
}: Props) {
  const trimmed = input.trim();
  const canSend = status === "ready" && trimmed.length > 0;
  const inFlight = status === "submitted" || status === "streaming";

  const submit = () => {
    if (!canSend) return;
    onSubmit(trimmed);
    setInput("");
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="shrink-0 bg-brand-canvas">
      <div className="mx-auto max-w-3xl px-4 pb-4 pt-2 sm:px-6">
        {error && (
          <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-brand-red/30 bg-brand-red/5 px-4 py-2.5 text-sm text-brand-charcoal">
            <span className="flex items-center gap-2">
              <WarningIcon />
              {friendlyErrorMessage(error)}
            </span>
            <button
              type="button"
              onClick={onRegenerate}
              className="rounded font-medium text-brand-red hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas"
            >
              Retry
            </button>
          </div>
        )}
        <form
          onSubmit={handleSubmit}
          className="flex items-end gap-2 rounded-2xl border border-brand-charcoal/15 bg-white p-2 shadow-[0_-4px_16px_-12px_rgba(45,46,41,0.15)] transition-colors focus-within:border-brand-red/40 focus-within:ring-1 focus-within:ring-brand-red/20"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about a customer, item, or order…"
            rows={1}
            className="max-h-32 min-h-9 flex-1 resize-none border-none bg-transparent px-2 py-2 text-sm leading-relaxed text-brand-charcoal placeholder:text-brand-ink-soft/70 focus:outline-none [field-sizing:content]"
          />
          {inFlight ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generating"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-brand-charcoal/30 bg-white text-brand-charcoal transition-colors hover:bg-brand-sand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Send message"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-red text-white transition-colors hover:bg-brand-red/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowUpIcon />
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

function ArrowUpIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 13V3" />
      <path d="M3 8l5-5 5 5" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="shrink-0 text-brand-red"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 4.5v4" strokeLinecap="round" />
      <circle cx="8" cy="11" r="0.5" fill="currentColor" />
    </svg>
  );
}
