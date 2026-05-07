"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatStatus, UIMessage } from "ai";
import { EmptyState } from "./EmptyState";

const STUCK_THRESHOLD_PX = 80;

type Props = {
  messages: UIMessage[];
  status: ChatStatus;
  onRegenerate: () => void;
  onSelectSuggestion: (text: string) => void;
};

export function MessageList({ messages, status, onRegenerate, onSelectSuggestion }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stuckToBottom, setStuckToBottom] = useState(true);
  const [hasNewSinceScrollAway, setHasNewSinceScrollAway] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = distFromBottom < STUCK_THRESHOLD_PX;
      setStuckToBottom(atBottom);
      if (atBottom) setHasNewSinceScrollAway(false);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stuckToBottom) {
      el.scrollTop = el.scrollHeight;
    } else {
      setHasNewSinceScrollAway(true);
    }
  }, [messages, status, stuckToBottom]);

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setHasNewSinceScrollAway(false);
  };

  const isEmpty = messages.length === 0;
  const showJumpPill = !stuckToBottom && hasNewSinceScrollAway;

  const lastAssistantIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return i;
    }
    return -1;
  })();

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-8 sm:px-6 lg:py-10">
        <div className="mx-auto flex max-w-3xl flex-col gap-8">
          {isEmpty ? (
            <EmptyState onSelectSuggestion={onSelectSuggestion} />
          ) : (
            messages.map((m, i) => (
              <Bubble
                key={m.id}
                message={m}
                showActions={i === lastAssistantIndex && status === "ready"}
                onRegenerate={onRegenerate}
              />
            ))
          )}
          {status === "submitted" && <TypingIndicator />}
        </div>
      </div>
      {showJumpPill && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-brand-charcoal/15 bg-white px-4 py-2 text-xs font-medium text-brand-charcoal shadow-md transition-colors hover:bg-brand-sand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas"
        >
          Jump to latest ↓
        </button>
      )}
    </div>
  );
}

function Bubble({
  message,
  showActions,
  onRegenerate,
}: {
  message: UIMessage;
  showActions: boolean;
  onRegenerate: () => void;
}) {
  const isUser = message.role === "user";
  const text = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");

  if (isUser) {
    return (
      <div className="flex justify-end animate-message-in">
        <div className="max-w-[75%] whitespace-pre-wrap rounded-2xl bg-brand-sand px-4 py-2.5 leading-relaxed text-brand-charcoal">
          {text}
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-3 animate-message-in">
      <Avatar />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="max-w-[90%] whitespace-pre-wrap rounded-2xl border border-brand-charcoal/10 bg-white px-4 py-2.5 leading-relaxed text-brand-charcoal">
          {text}
        </div>
        {showActions && <MessageActions text={text} onRegenerate={onRegenerate} />}
      </div>
    </div>
  );
}

function Avatar() {
  return (
    <div
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-brand-red text-xs font-bold tracking-wide text-white"
      aria-hidden
    >
      O
    </div>
  );
}

function MessageActions({ text, onRegenerate }: { text: string; onRegenerate: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be blocked in some contexts; fail silently
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onRegenerate}
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-brand-charcoal/15 bg-white px-3 text-xs font-medium text-brand-charcoal transition-colors hover:border-brand-charcoal/30 hover:bg-brand-sand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas"
      >
        <RefreshIcon />
        Regenerate response
      </button>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy message"}
        className="inline-flex h-8 w-8 items-center justify-center rounded-full text-brand-ink-soft opacity-0 transition-all hover:bg-brand-sand/40 hover:text-brand-charcoal focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas group-hover:opacity-100"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 8.5L6.5 12L13 4.5" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 8a6 6 0 0 1-10.5 4M2 8a6 6 0 0 1 10.5-4" />
      <path d="M14 3v3.5h-3.5" />
      <path d="M2 13v-3.5h3.5" />
    </svg>
  );
}

function TypingIndicator() {
  return (
    <div className="flex items-start gap-3 animate-message-in">
      <Avatar />
      <div className="flex items-center gap-1 rounded-2xl border border-brand-charcoal/10 bg-white px-4 py-3">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-ink-soft [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-ink-soft [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-ink-soft [animation-delay:300ms]" />
      </div>
    </div>
  );
}
