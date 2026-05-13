"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PlusIcon } from "@/components/icons";
import { Wordmark } from "@/components/Wordmark";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { Sidebar, type ConversationSummary } from "./Sidebar";
import { signOutAction } from "./actions";

type Props = {
  initialConversationId?: string;
  initialMessages?: UIMessage[];
  isAdmin?: boolean;
};

export function ChatShell({ initialConversationId, initialMessages, isAdmin }: Props) {
  const router = useRouter();
  // Lives outside React state so the transport's body callback (which fires
  // outside the React render path) can read the current id without a
  // re-render. Mirrored into state for the sidebar's "active" highlight.
  const conversationIdRef = useRef<string | null>(initialConversationId ?? null);
  const [conversationId, setConversationId] = useState<string | null>(
    initialConversationId ?? null,
  );
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);

  // Single transport for the shell's lifetime. `body` is invoked per-request
  // by the AI SDK, so reading the ref there is safe — it's not a render-time
  // access of `.current` even though the source position is inside an
  // initializer. The `useState` form lets us construct it lazily, once.
  /* eslint-disable react-hooks/refs */
  const [transport] = useState(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        body: () => ({ conversationId: conversationIdRef.current ?? undefined }),
      }),
  );
  /* eslint-enable react-hooks/refs */

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
  } = useChat({ transport, messages: initialMessages });

  async function refreshConversations() {
    try {
      const res = await fetch("/api/conversations", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { conversations: ConversationSummary[] };
      setConversations(data.conversations ?? []);
    } catch {
      // sidebar history is non-critical; fail silently
    }
  }

  useEffect(() => {
    // Mount-time fetch: the sidebar list is owned by the server, so the
    // first render needs a fetch. setState in this effect is intentional.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshConversations();
  }, []);

  // After every assistant message lands, refresh the sidebar — the active
  // row's updatedAt has moved, and any new chat now has a row.
  const lastStatusRef = useRef(status);
  useEffect(() => {
    if (lastStatusRef.current !== "ready" && status === "ready") {
      void refreshConversations();
    }
    lastStatusRef.current = status;
  }, [status]);

  function startNewChat() {
    setMessages([]);
    clearError();
    setInput("");
    conversationIdRef.current = null;
    setConversationId(null);
    router.push("/chat");
  }

  async function submitMessage(text: string) {
    // Pre-create the conversation so subsequent turns and the URL both see
    // a real id. Skip on the second+ turn (id already set), and tolerate
    // failures — the chat route will create one server-side if we miss.
    if (!conversationIdRef.current) {
      try {
        const res = await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: text }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            conversation: { id: string };
          };
          conversationIdRef.current = data.conversation.id;
          setConversationId(data.conversation.id);
          // History API instead of router.replace: we want the URL to track
          // the new conversation id, but `router.replace` triggers a Next
          // navigation that remounts ChatShell — which would drop the
          // in-flight `useChat` state and show the empty placeholder while
          // the assistant streams onto the unmounted component. Updating
          // history directly keeps the running component alive; the next
          // hard navigation (refresh, deep link) hits /chat/[id] cleanly.
          window.history.replaceState(null, "", `/chat/${data.conversation.id}`);
        }
      } catch {
        // Falls through — server will create if we didn't send an id
      }
    }
    sendMessage({ text });
  }

  useEffect(() => {
    function copyLatestAssistant() {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== "assistant") continue;
        const text = m.parts
          .filter(
            (p): p is { type: "text"; text: string } =>
              typeof p === "object" && p !== null && "type" in p && p.type === "text",
          )
          .map((p) => p.text)
          .join("");
        if (text) {
          navigator.clipboard.writeText(text).catch(() => {});
          return;
        }
      }
    }

    function handler(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        startNewChat();
        return;
      }
      if (mod && e.key === "/") {
        e.preventDefault();
        const el = document.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]");
        el?.focus();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        copyLatestAssistant();
        return;
      }
      if (e.key === "Escape" && (status === "streaming" || status === "submitted")) {
        e.preventDefault();
        stop();
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, status]);

  async function onDeleteConversation(id: string) {
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    await refreshConversations();
    if (conversationId === id) startNewChat();
  }

  return (
    <div className="flex h-dvh bg-brand-canvas">
      <Sidebar
        conversations={conversations}
        activeId={conversationId}
        onNewChat={startNewChat}
        onDelete={onDeleteConversation}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile / tablet top bar (hidden on lg+) */}
        <header className="flex h-14 shrink-0 items-center gap-2 bg-brand-charcoal px-3 lg:hidden">
          <Link
            href="/chat"
            aria-label="Olander Agents — chat home"
            className="rounded-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-charcoal"
          >
            <Wordmark variant="topbar" />
          </Link>
          <button
            type="button"
            onClick={startNewChat}
            aria-label="Start a new chat"
            className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-white/15 bg-white/5 text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-charcoal"
          >
            <PlusIcon />
          </button>
          <AccountMenu variant="charcoal" isAdmin={isAdmin} />
        </header>

        {/* Desktop top strip with status pill (hidden under lg) */}
        <header className="relative hidden h-12 shrink-0 items-center justify-center border-b border-brand-charcoal/[0.06] lg:flex">
          <span className="rounded-full border border-brand-charcoal/10 bg-white px-3 py-1 text-xs text-brand-ink-soft">
            Demo mode — sample data only
          </span>
          <div className="absolute inset-y-0 right-4 flex items-center">
            <AccountMenu variant="canvas" isAdmin={isAdmin} />
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
            onSubmit={(text) => void submitMessage(text)}
            onStop={stop}
            onRegenerate={() => regenerate()}
          />
        </main>
      </div>
    </div>
  );
}

function AccountMenu({
  variant,
  isAdmin,
}: {
  variant: "canvas" | "charcoal";
  isAdmin?: boolean;
}) {
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
          {isAdmin && (
            <>
              <Link
                href="/admin"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="block w-full px-3 py-2 text-left text-sm text-brand-charcoal transition-colors hover:bg-brand-sand/40 focus-visible:bg-brand-sand/40 focus-visible:outline-none"
              >
                Admin panel
              </Link>
              <div className="my-1 h-px bg-brand-charcoal/10" />
            </>
          )}
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
