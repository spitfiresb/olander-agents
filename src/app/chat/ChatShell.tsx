"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import Link from "next/link";
import { useState } from "react";
import { Wordmark } from "@/components/Wordmark";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { Sidebar } from "./Sidebar";
import { signOutAction } from "./actions";

type SessionUser = {
  name: string | null;
  email: string | null;
};

export function ChatShell({ user }: { user: SessionUser }) {
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
        <header className="flex h-14 shrink-0 items-center gap-2 bg-brand-charcoal px-3 lg:hidden">
          <Link
            href="/"
            aria-label="Olander Agents — back to home"
            className="rounded-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-charcoal"
          >
            <Wordmark variant="topbar" />
          </Link>
          <span
            className="ml-auto max-w-[140px] truncate text-xs text-white/70"
            title={user.email ?? undefined}
          >
            {user.email}
          </span>
          <button
            type="button"
            onClick={clearChat}
            aria-label="Start a new chat"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-white/15 bg-white/5 text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-charcoal"
          >
            <PlusIcon />
          </button>
          <form action={signOutAction}>
            <button
              type="submit"
              aria-label="Sign out"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-white/15 bg-white/5 text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-charcoal"
            >
              <SignOutIcon />
            </button>
          </form>
        </header>

        {/* Desktop top strip with status pill (hidden under lg) */}
        <header className="relative hidden h-12 shrink-0 items-center justify-center border-b border-brand-charcoal/[0.06] lg:flex">
          <span className="rounded-full border border-brand-charcoal/10 bg-white px-3 py-1 text-xs text-brand-ink-soft">
            Demo mode — sample data only
          </span>
          <UserPill user={user} className="absolute right-4" />
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

function UserPill({
  user,
  className = "",
}: {
  user: SessionUser;
  className?: string;
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded-full border border-brand-charcoal/10 bg-white px-1 py-1 pl-3 text-xs text-brand-ink-soft ${className}`}
    >
      <span
        className="max-w-[200px] truncate"
        title={user.email ?? undefined}
      >
        {user.email ?? user.name ?? "Signed in"}
      </span>
      <form action={signOutAction}>
        <button
          type="submit"
          className="rounded-full bg-brand-charcoal px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-brand-charcoal/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2"
        >
          Sign out
        </button>
      </form>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3" />
      <path d="M10 5l3 3-3 3" />
      <path d="M13 8H6" />
    </svg>
  );
}
