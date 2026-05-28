"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatStatus } from "ai";
import {
  ChevronDownIcon,
  DownloadIcon,
  PencilIcon,
  PinIcon,
  TrashIcon,
} from "@/components/icons";
import { RenameInput } from "./RenameInput";

// Active-chat title trigger + dropdown menu (pin, rename, export, delete).
// Mirrors AccountMenu's dropdown pattern (click-outside via pointerdown +
// containerRef, Esc-to-close, aria-haspopup/aria-expanded, role=menu /
// role=menuitem, animate-menu-in surface). Render only when a conversation
// is loaded; ChatShell gates on activeConversation != null.
//
// Two layout variants:
//   - desktop: sits in the existing h-12 top strip, left side
//   - mobile:  sits in a new h-11 canvas-bg bar below the charcoal app-bar
// Visuals are identical; the variant flag is just for the parent's flex
// sizing context.

type Props = {
  conversationId: string;
  title: string;
  pinnedAt: string | null;
  status: ChatStatus;
  onRename: (id: string, nextTitle: string) => Promise<void> | void;
  onTogglePin: (id: string, nextPinned: boolean) => void;
  // ChatShell wraps with window.confirm() before calling — keep the prop
  // shape simple so future callers can substitute their own confirmation.
  onDelete: (id: string) => void;
  variant?: "desktop" | "mobile";
};

export function ChatHeader({
  conversationId,
  title,
  pinnedAt,
  status,
  onRename,
  onTogglePin,
  onDelete,
  variant = "desktop",
}: Props) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const isPinned = pinnedAt != null;
  const streaming = status === "streaming" || status === "submitted";

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

  // Inline rename takes over the trigger slot — same UX shape as the
  // sidebar's pencil affordance, just on a canvas surface this time.
  if (editing) {
    return (
      <div
        className={`min-w-0 max-w-md ${variant === "mobile" ? "flex-1" : ""}`}
      >
        <RenameInput
          variant="canvas"
          initial={title}
          onCommit={async (next) => {
            const trimmed = next.trim();
            if (trimmed && trimmed !== title) {
              await onRename(conversationId, trimmed);
            }
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  const menuItemBase =
    "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-brand-sand/40 focus-visible:bg-brand-sand/40 focus-visible:outline-none";

  return (
    <div
      ref={containerRef}
      className={`relative min-w-0 ${variant === "mobile" ? "flex-1" : ""}`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Conversation menu"
        className="flex min-w-0 max-w-md items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-brand-charcoal transition-colors hover:bg-brand-sand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2"
      >
        <span className="min-w-0 truncate">{title}</span>
        <ChevronDownIcon
          className={`shrink-0 transition-transform duration-150 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="animate-menu-in absolute left-0 top-full z-20 mt-2 min-w-[200px] overflow-hidden rounded-2xl border border-brand-charcoal/10 bg-white py-1 shadow-md"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onTogglePin(conversationId, !isPinned);
              setOpen(false);
            }}
            className={`${menuItemBase} text-brand-charcoal`}
          >
            <PinIcon filled={isPinned} />
            {isPinned ? "Unpin" : "Pin"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setEditing(true);
            }}
            className={`${menuItemBase} text-brand-charcoal`}
          >
            <PencilIcon />
            Rename
          </button>
          <a
            href={`/api/conversations/${conversationId}/export`}
            download
            role="menuitem"
            onClick={() => setOpen(false)}
            className={`${menuItemBase} text-brand-charcoal`}
          >
            <DownloadIcon />
            Export as markdown
          </a>
          <div className="my-1 h-px bg-brand-charcoal/10" />
          <button
            type="button"
            role="menuitem"
            disabled={streaming}
            onClick={() => {
              onDelete(conversationId);
              setOpen(false);
            }}
            className={`${menuItemBase} text-brand-red disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent`}
          >
            <TrashIcon />
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
