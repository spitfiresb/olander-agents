"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Wordmark } from "@/components/Wordmark";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { Sidebar } from "./Sidebar";
import { signOutAction } from "./actions";

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
        <header className="flex h-14 shrink-0 items-center gap-2 bg-brand-charcoal px-3 lg:hidden">
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
            className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-white/15 bg-white/5 text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-charcoal"
          >
            <PlusIcon />
          </button>
          <AccountMenu variant="charcoal" />
        </header>

        {/* Desktop top strip with status pill (hidden under lg) */}
        <header className="relative hidden h-12 shrink-0 items-center justify-center border-b border-brand-charcoal/[0.06] lg:flex">
          <span className="rounded-full border border-brand-charcoal/10 bg-white px-3 py-1 text-xs text-brand-ink-soft">
            Demo mode — sample data only
          </span>
          <div className="absolute inset-y-0 right-4 flex items-center">
            <AccountMenu variant="canvas" />
          </div>
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

function AccountMenu({ variant }: { variant: "canvas" | "charcoal" }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const triggerClass =
    variant === "charcoal"
      ? "border-white/15 bg-white/5 text-white hover:bg-white/10 focus-visible:ring-white/40 focus-visible:ring-offset-brand-charcoal"
      : "border-brand-charcoal/15 bg-white text-brand-ink-soft hover:border-brand-charcoal/30 hover:bg-brand-sand/40 focus-visible:ring-brand-red";

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${triggerClass}`}
      >
        <SettingsIcon />
      </button>

      {open && (
        <div
          role="menu"
          className="animate-menu-in absolute right-0 top-full z-20 mt-2 min-w-[160px] overflow-hidden rounded-2xl border border-brand-charcoal/10 bg-white py-1 shadow-md"
        >
          <form action={signOutAction}>
            <button
              type="submit"
              role="menuitem"
              className="block w-full px-3 py-2 text-left text-sm text-brand-charcoal transition-colors hover:bg-brand-sand/40 focus-visible:bg-brand-sand/40 focus-visible:outline-none"
            >
              Sign out
            </button>
          </form>
        </div>
      )}
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

function SettingsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
