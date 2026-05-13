"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatStatus, UIMessage } from "ai";
import { AssistantContent } from "@/components/chat/AssistantContent";
import { isToolPart, ToolCallCard, type ToolPartLike } from "@/components/chat/ToolCallCard";
import { summarizeToolUsageForCitation } from "@/lib/ai/tool-labels";
import { AttachmentChip } from "./AttachmentChip";
import { EmptyState } from "./EmptyState";

type FilePart = {
  type: "file";
  mediaType: string;
  url: string;
  filename: string;
  size?: number;
};

const isFilePart = (p: unknown): p is FilePart =>
  typeof p === "object" &&
  p !== null &&
  "type" in p &&
  (p as { type: string }).type === "file" &&
  "url" in p &&
  "mediaType" in p &&
  "filename" in p;

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

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setStuckToBottom(distFromBottom < STUCK_THRESHOLD_PX);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stuckToBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, status, stuckToBottom]);

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const isEmpty = messages.length === 0;
  const showJumpPill = !isEmpty && !stuckToBottom;
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;

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
            messages.map((m, i) => {
              const isLast = i === lastAssistantIndex;
              return (
                <Bubble
                  key={m.id}
                  message={m}
                  showActions={isLast && status === "ready"}
                  inFlight={isLast && status !== "ready"}
                  onRegenerate={onRegenerate}
                />
              );
            })
          )}
          {status === "submitted" && (
            // Only show the standalone typing indicator before the assistant
            // has started any tool call or text — once parts arrive, the
            // bubble itself shows in-flight states.
            lastMessageId == null ||
            messages[messages.length - 1].role !== "assistant" ? (
              <TypingIndicator />
            ) : null
          )}
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
  inFlight,
  onRegenerate,
}: {
  message: UIMessage;
  showActions: boolean;
  inFlight: boolean;
  onRegenerate: () => void;
}) {
  const isUser = message.role === "user";

  type TextPart = { type: "text"; text: string };
  const isTextPart = (p: unknown): p is TextPart =>
    typeof p === "object" && p !== null && "type" in p &&
    (p as { type: string }).type === "text";

  if (isUser) {
    const userText = message.parts
      .filter(isTextPart)
      .map((p) => p.text)
      .join("\n\n");
    const userFiles = message.parts.filter(isFilePart);
    return (
      <div className="flex justify-end animate-message-in">
        <div className="flex max-w-[80%] flex-col items-end gap-2">
          {userFiles.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2">
              {userFiles.map((f, i) => (
                <AttachmentChip
                  key={`${f.url}-${i}`}
                  filename={f.filename}
                  mediaType={f.mediaType}
                  size={f.size}
                  url={f.url}
                  variant="message"
                  status="ready"
                />
              ))}
            </div>
          )}
          {userText && (
            <div className="whitespace-pre-wrap rounded-2xl bg-brand-sand px-4 py-2.5 leading-relaxed text-brand-charcoal">
              {userText}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Walk parts in order, grouping consecutive text into one bubble so the
  // UI mirrors how the assistant actually thought: text → tool → text → tool.
  type Group =
    | { kind: "text"; text: string }
    | { kind: "tool"; part: ToolPartLike; key: string };
  const groups: Group[] = [];
  for (let i = 0; i < message.parts.length; i++) {
    const part = message.parts[i];
    if (isTextPart(part)) {
      const last = groups[groups.length - 1];
      if (last && last.kind === "text") {
        last.text += part.text;
      } else if (part.text.length > 0) {
        groups.push({ kind: "text", text: part.text });
      }
    } else if (isToolPart(part)) {
      groups.push({ kind: "tool", part, key: part.toolCallId ?? `t${i}` });
    }
  }

  const allText = groups
    .filter((g): g is Extract<Group, { kind: "text" }> => g.kind === "text")
    .map((g) => g.text)
    .join("\n\n");
  const hasText = allText.length > 0;

  const toolParts: ToolPartLike[] = groups
    .filter((g): g is Extract<Group, { kind: "tool" }> => g.kind === "tool")
    .map((g) => g.part);
  const citations = toolParts
    .map((part) =>
      summarizeToolUsageForCitation(
        part.type.replace(/^tool-/, ""),
        part.input,
        part.output,
      ),
    )
    .filter((s): s is string => Boolean(s));

  // Intermediate reasoning + tool calls live in the steps container from
  // the moment the first tool call appears, so the layout is stable both
  // during streaming and after. When streaming ends, only the disclosure
  // pill fades in and the container collapses — no content relocates.
  //
  // Rule: if any tool call exists, treat the last text part (if any) as
  // the current/final answer in the main column, and everything else as
  // steps in the container. If the last part is a tool call (model is
  // still working), keep everything in the container with no final yet.
  const hasToolCall = groups.some((g) => g.kind === "tool");
  const lastGroup = groups[groups.length - 1];
  const lastIsText = lastGroup?.kind === "text";

  let stepGroups: Group[];
  let finalGroups: Group[];
  if (!hasToolCall) {
    stepGroups = [];
    finalGroups = groups;
  } else if (lastIsText) {
    stepGroups = groups.slice(0, -1);
    finalGroups = [lastGroup];
  } else {
    stepGroups = groups;
    finalGroups = [];
  }
  const hasStepGroups = stepGroups.length > 0;

  return (
    <div className="group flex items-start gap-3 animate-message-in">
      <Avatar />
      <div className="flex min-w-0 max-w-[90%] flex-1 flex-col gap-3">
        {hasStepGroups && (
          <StepsDisclosure
            groups={stepGroups}
            inFlight={inFlight}
          />
        )}
        {finalGroups.map((g, i) =>
          g.kind === "text" ? (
            <div
              key={`text-${i}`}
              className="rounded-2xl border border-brand-charcoal/10 bg-white px-4 py-3 leading-relaxed text-brand-charcoal"
            >
              <AssistantContent text={g.text} />
            </div>
          ) : (
            <ToolCallCard key={g.key} part={g.part} />
          ),
        )}
        {citations.length > 0 && hasText && (
          <div className="text-[11px] text-brand-ink-soft">
            Data: {citations.join(", ")}
          </div>
        )}
        {showActions && hasText && (
          <MessageActions text={allText} onRegenerate={onRegenerate} />
        )}
      </div>
    </div>
  );
}

function StepsDisclosure({
  groups,
  inFlight,
}: {
  groups: Array<
    | { kind: "text"; text: string }
    | { kind: "tool"; part: ToolPartLike; key: string }
  >;
  inFlight: boolean;
}) {
  // userOpen tracks intent from the disclosure button; while streaming we
  // force the panel open regardless so the rep can watch progress. When
  // inFlight flips to false, stepsOpen flips to userOpen (false by default)
  // and the grid-template-rows transition animates the collapse smoothly.
  const [userOpen, setUserOpen] = useState(false);
  const stepsOpen = inFlight || userOpen;

  const toolCount = groups.filter((g) => g.kind === "tool").length;
  const label =
    toolCount > 0
      ? `${toolCount} ${toolCount === 1 ? "step" : "steps"}`
      : "Reasoning";

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setUserOpen((v) => !v)}
        aria-expanded={stepsOpen}
        className={`inline-flex w-fit items-center gap-1.5 rounded-full border border-brand-charcoal/15 bg-white px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-brand-ink-soft transition-all duration-300 hover:border-brand-charcoal/30 hover:text-brand-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas ${
          inFlight ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
      >
        <DisclosureChevron open={stepsOpen} />
        <span>{userOpen ? "Hide" : "Show"} {label}</span>
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-out ${
          stepsOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-2 border-l-2 border-brand-charcoal/10 pl-3 pt-2">
            {groups.map((g, i) =>
              g.kind === "text" ? (
                <div
                  key={`step-text-${i}`}
                  className="rounded-2xl border border-brand-charcoal/10 bg-white px-4 py-3 text-sm leading-relaxed text-brand-charcoal"
                >
                  <AssistantContent text={g.text} />
                </div>
              ) : (
                <ToolCallCard key={g.key} part={g.part} />
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DisclosureChevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="10"
      height="10"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`transition-transform ${open ? "rotate-90" : ""}`}
      aria-hidden
    >
      <path d="M6 3l5 5-5 5" />
    </svg>
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
        <span className="animate-typing-dot h-1.5 w-1.5 rounded-full bg-brand-ink-soft [animation-delay:0ms]" />
        <span className="animate-typing-dot h-1.5 w-1.5 rounded-full bg-brand-ink-soft [animation-delay:200ms]" />
        <span className="animate-typing-dot h-1.5 w-1.5 rounded-full bg-brand-ink-soft [animation-delay:400ms]" />
      </div>
    </div>
  );
}
