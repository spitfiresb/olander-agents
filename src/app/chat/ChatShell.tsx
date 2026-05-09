"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import Link from "next/link";
import { useState } from "react";
import { PlusIcon } from "@/components/icons";
import { Wordmark } from "@/components/Wordmark";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { Sidebar } from "./Sidebar";

export function ChatShell() {
  const [transport] = useState(
    () => new DefaultChatTransport({ api: "/api/chat" }),
  );
  const [input, setInput] = useState("");
  const {
    messages,
    sendMessage,
    status,
    error,
    stop,
    regenerate,
    setMessages,
    clearError,
  } = useChat({ transport });

  const clearChat = () => {
    setMessages([]);
    clearError();
    setInput("");
  };

  return (
    <div className="flex h-dvh bg-brand-canvas">
      <Sidebar onNewChat={clearChat} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile / tablet top bar (hidden on lg+) */}
        <header className="flex h-14 shrink-0 items-center bg-brand-charcoal px-4 lg:hidden">
          <Link
            href="/"
            aria-label="Olander Agents — back to home"
            className="rounded-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-charcoal"
          >
            <Wordmark variant="topbar" />
          </Link>
          <button
            type="button"
            onClick={clearChat}
            aria-label="Start a new chat"
            className="ml-auto flex h-9 w-9 items-center justify-center rounded-md border border-white/15 bg-white/5 text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-charcoal"
          >
            <PlusIcon />
          </button>
        </header>

        {/* Desktop top strip with status pill (hidden under lg) */}
        <header className="hidden h-12 shrink-0 items-center justify-center border-b border-brand-charcoal/[0.06] lg:flex">
          <span className="rounded-full border border-brand-charcoal/10 bg-white px-3 py-1 text-xs text-brand-ink-soft">
            Demo mode — sample data only
          </span>
        </header>

        <main className="flex min-h-0 flex-1 flex-col">
          <MessageList
            messages={messages}
            status={status}
            onRegenerate={() => regenerate()}
            onSelectSuggestion={setInput}
          />
          <Composer
            input={input}
            setInput={setInput}
            status={status}
            error={error}
            onSubmit={(text) => sendMessage({ text })}
            onStop={stop}
            onRegenerate={() => regenerate()}
          />
        </main>
      </div>
    </div>
  );
}
