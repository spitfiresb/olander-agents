"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type DragEvent as ReactDragEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { HamburgerIcon } from "@/components/icons";
import { Wordmark } from "@/components/Wordmark";
import { Composer, type ComposerAttachment } from "./Composer";
import { MessageList } from "./MessageList";
import { MobileSidebarDrawer } from "./MobileSidebarDrawer";
import { Sidebar, type ConversationSummary } from "./Sidebar";
import { signOutAction } from "./actions";

// Client-side mirror of the server allowlist + caps (src/lib/blob.ts +
// /api/uploads). The OS picker accept list filters at selection time and
// these gates filter the drag/paste paths; the server re-validates
// authoritatively.
const ALLOWED_MIME = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_FILE_COUNT = 5;

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
  const [searchQuery, setSearchQuery] = useState("");
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentBanner, setAttachmentBanner] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  // dragenter/leave fire for every child crossed during a drag; the depth
  // counter keeps the overlay visible until the drag truly leaves the
  // outermost target. Reset on drop.
  const dragDepth = useRef(0);
  // `refreshConversations` is recreated on render but only ever read by
  // effects/handlers via the ref. The ref decouples the latest-search-query
  // closure from the effect identity so the status-change effect doesn't
  // need searchQuery in its deps (which would cause stray refetches).
  const searchQueryRef = useRef(searchQuery);
  useEffect(() => {
    searchQueryRef.current = searchQuery;
  }, [searchQuery]);

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
      const q = searchQueryRef.current.trim();
      const url = q
        ? `/api/conversations?q=${encodeURIComponent(q)}`
        : "/api/conversations";
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { conversations: ConversationSummary[] };
      setConversations(data.conversations ?? []);
    } catch {
      // sidebar history is non-critical; fail silently
    }
  }

  useEffect(() => {
    // Empty query refreshes immediately (mount + after clearing search);
    // typing into the search box debounces 200ms so we don't fire a fetch
    // on every keystroke. The cleanup cancels any pending fetch when the
    // query changes again or the component unmounts. `refreshConversations`
    // reads the latest query via searchQueryRef, so it doesn't need to live
    // in this effect's dep array.
    if (searchQuery === "") {
      void refreshConversations();
      return;
    }
    const t = setTimeout(() => {
      void refreshConversations();
    }, 200);
    return () => clearTimeout(t);
  }, [searchQuery]);

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
    setAttachments([]);
    setAttachmentBanner(null);
    conversationIdRef.current = null;
    setConversationId(null);
    router.push("/chat");
  }

  async function uploadOne(id: string, file: File) {
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch("/api/uploads", { method: "POST", body: form });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "upload_failed");
      }
      const data = (await res.json()) as {
        attachment: {
          url: string;
          pathname: string;
          mediaType: string;
          size: number;
          filename: string;
        };
      };
      setAttachments((prev) =>
        prev.map((a) =>
          a.id === id
            ? {
                ...a,
                status: "ready",
                url: data.attachment.url,
                pathname: data.attachment.pathname,
              }
            : a,
        ),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "upload_failed";
      const friendly =
        msg === "file_too_large"
          ? "Too large (10 MB max)"
          : msg === "unsupported_mime"
            ? "Unsupported type"
            : msg === "rate_limited"
              ? "Too many uploads — try again"
              : "Upload failed";
      setAttachments((prev) =>
        prev.map((a) =>
          a.id === id ? { ...a, status: "error", errorMessage: friendly } : a,
        ),
      );
    }
  }

  function addFiles(files: FileList | File[]) {
    const fileArr = Array.from(files);
    const rejections: string[] = [];
    setAttachments((current) => {
      const next = [...current];
      let runningTotal = current.reduce((s, a) => s + a.size, 0);
      for (const file of fileArr) {
        if (!ALLOWED_MIME.has(file.type)) {
          rejections.push(`${file.name}: unsupported type`);
          continue;
        }
        if (file.size > MAX_FILE_BYTES) {
          rejections.push(`${file.name}: too large (10 MB max)`);
          continue;
        }
        if (next.length >= MAX_FILE_COUNT) {
          rejections.push(`${file.name}: max 5 files per message`);
          continue;
        }
        if (runningTotal + file.size > MAX_TOTAL_BYTES) {
          rejections.push(`${file.name}: total exceeds 25 MB`);
          continue;
        }
        const id =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `att-${Date.now()}-${Math.random()}`;
        next.push({
          id,
          filename: file.name,
          mediaType: file.type,
          size: file.size,
          status: "uploading",
        });
        runningTotal += file.size;
        // Fire upload async; the chip will update via setAttachments inside.
        void uploadOne(id, file);
      }
      return next;
    });
    if (rejections.length > 0) {
      setAttachmentBanner(rejections.join("; "));
      // Auto-clear after a moment so the banner doesn't pin forever.
      setTimeout(() => setAttachmentBanner(null), 5000);
    }
  }

  async function removeAttachment(id: string) {
    let pathname: string | undefined;
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      pathname = target?.pathname;
      return prev.filter((a) => a.id !== id);
    });
    if (pathname) {
      try {
        await fetch("/api/uploads", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pathname }),
        });
      } catch {
        // Blob lingers as an orphan; the eventual sweeper picks it up.
      }
    }
  }

  async function submitMessage() {
    const text = input.trim();
    const ready = attachments.filter((a) => a.status === "ready" && a.url);
    if (!text && ready.length === 0) return;

    // Pre-create the conversation so subsequent turns and the URL both see
    // a real id. Skip on the second+ turn (id already set), and tolerate
    // failures — the chat route will create one server-side if we miss.
    if (!conversationIdRef.current) {
      const titleSeed = text || ready[0]?.filename || "Untitled chat";
      try {
        const res = await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: titleSeed }),
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

    type Part =
      | { type: "text"; text: string }
      | {
          type: "file";
          mediaType: string;
          url: string;
          filename: string;
          size?: number;
        };
    const parts: Part[] = [];
    for (const att of ready) {
      parts.push({
        type: "file",
        mediaType: att.mediaType,
        url: att.url!,
        filename: att.filename,
        size: att.size,
      });
    }
    if (text) parts.push({ type: "text", text });

    // useChat.sendMessage accepts a UIMessage-shaped object; passing `parts`
    // bypasses the convenience `text` shorthand and is the only way to send
    // a multi-part message containing file references.
    sendMessage({ parts } as unknown as Parameters<typeof sendMessage>[0]);
    setInput("");
    setAttachments([]);
  }

  function hasFilesPayload(e: ReactDragEvent): boolean {
    // Some browsers report "Files" in dataTransfer.types only mid-drag; the
    // fallback to .items keeps Firefox happy on dragenter.
    if (e.dataTransfer.types.includes("Files")) return true;
    return Array.from(e.dataTransfer.items ?? []).some(
      (it) => it.kind === "file",
    );
  }

  const onDragEnter = (e: ReactDragEvent) => {
    if (!hasFilesPayload(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  };

  const onDragOver = (e: ReactDragEvent) => {
    if (!hasFilesPayload(e)) return;
    e.preventDefault();
  };

  const onDragLeave = (e: ReactDragEvent) => {
    if (!hasFilesPayload(e)) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  };

  const onDrop = (e: ReactDragEvent) => {
    if (!hasFilesPayload(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  };

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

  async function onTogglePin(id: string, nextPinned: boolean) {
    // Optimistic update so the row jumps to/from the Pinned group without
    // waiting on the round-trip. If the PATCH fails, the next refresh undoes
    // the optimistic change.
    setConversations((prev) =>
      prev.map((c) =>
        c.id === id
          ? { ...c, pinnedAt: nextPinned ? new Date().toISOString() : null }
          : c,
      ),
    );
    try {
      await fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: nextPinned }),
      });
    } finally {
      await refreshConversations();
    }
  }

  async function onRenameConversation(id: string, nextTitle: string) {
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title: nextTitle } : c)),
    );
    try {
      await fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: nextTitle }),
      });
    } finally {
      await refreshConversations();
    }
  }

  return (
    <div className="flex h-dvh bg-brand-canvas">
      {/* Desktop sidebar (hidden under lg). The mobile drawer below renders
          the same Sidebar component inside a slide-over container. */}
      <div className="hidden lg:flex">
        <Sidebar
          conversations={conversations}
          activeId={conversationId}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onNewChat={startNewChat}
          onDelete={onDeleteConversation}
          onTogglePin={onTogglePin}
          onRename={onRenameConversation}
        />
      </div>

      <MobileSidebarDrawer
        open={mobileDrawerOpen}
        onClose={() => setMobileDrawerOpen(false)}
      >
        <Sidebar
          conversations={conversations}
          activeId={conversationId}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onNewChat={() => {
            setMobileDrawerOpen(false);
            startNewChat();
          }}
          onDelete={onDeleteConversation}
          onTogglePin={onTogglePin}
          onRename={onRenameConversation}
          onRowSelect={() => setMobileDrawerOpen(false)}
        />
      </MobileSidebarDrawer>

      <div
        className="relative flex min-w-0 flex-1 flex-col"
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {/* Mobile / tablet top bar (hidden on lg+) */}
        <header className="flex h-14 shrink-0 items-center gap-2 bg-brand-charcoal px-3 lg:hidden">
          <button
            type="button"
            onClick={() => setMobileDrawerOpen(true)}
            aria-label="Open chat history"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-white/15 bg-white/5 text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-charcoal"
          >
            <HamburgerIcon />
          </button>
          <Link
            href="/"
            aria-label="Olander Agents — back to home"
            className="mx-auto rounded-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-charcoal"
          >
            <Wordmark variant="topbar" />
          </Link>
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
          {attachmentBanner && (
            <div className="mx-auto mt-2 max-w-3xl rounded-lg border border-brand-red/30 bg-brand-red/5 px-4 py-2 text-xs text-brand-charcoal">
              {attachmentBanner}
            </div>
          )}
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
            attachments={attachments}
            onAddFiles={addFiles}
            onRemoveAttachment={(id) => void removeAttachment(id)}
            onSubmit={() => void submitMessage()}
            onStop={stop}
            onRegenerate={() => regenerate()}
          />
        </main>

        {/* Full-surface drop overlay (Claude.ai style). Covers the main
            column only; sidebar drag is a no-op. pointer-events:none so the
            drag/drop events still hit the underlying chat surface that owns
            the handlers. */}
        {isDragging && (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-brand-charcoal/25 backdrop-blur-[2px]">
            <div className="rounded-2xl border-2 border-dashed border-brand-red bg-white/95 px-8 py-6 text-center shadow-lg">
              <div className="text-base font-medium text-brand-charcoal">
                Drop files to attach
              </div>
              <div className="mt-1 text-xs text-brand-ink-soft">
                Images, PDFs, or spreadsheets — up to 10 MB each, 5 per message
              </div>
            </div>
          </div>
        )}
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
