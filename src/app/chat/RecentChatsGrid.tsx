"use client";

import Link from "next/link";
import { PinIcon } from "@/components/icons";
import { formatRelativeTime } from "@/lib/relative-time";
import type { ConversationSummary } from "./Sidebar";

// 2-col grid of recent-chat cards for the empty-state warm-start view
// (Stage 4b). Conversations come pre-sorted from /api/conversations
// (pinned first, then updatedAt desc); we just slice the first N. Each
// card is one Link → clicking resumes the chat. The pin glyph in the
// top-right corner mirrors the sidebar's filled-pin treatment so the
// signal carries across surfaces.

type Props = {
  conversations: ConversationSummary[];
  limit?: number;
};

export function RecentChatsGrid({ conversations, limit = 6 }: Props) {
  const items = conversations.slice(0, limit);
  if (items.length === 0) return null;

  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {items.map((c) => (
        <li key={c.id} className="animate-message-in">
          <RecentChatCard conversation={c} />
        </li>
      ))}
    </ul>
  );
}

function RecentChatCard({ conversation }: { conversation: ConversationSummary }) {
  const isPinned = conversation.pinnedAt != null;
  // Trim whitespace and treat empty strings as null so the snippet row
  // collapses cleanly when the first user message had no text parts
  // (attachment-only send).
  const snippet = conversation.snippet?.trim() || null;

  return (
    <Link
      href={`/chat/${conversation.id}`}
      className="block rounded-2xl border border-brand-charcoal/10 bg-white px-4 py-3 transition-colors hover:border-brand-charcoal/30 hover:bg-brand-sand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-brand-charcoal">
          {conversation.title}
        </h3>
        {isPinned && (
          <span className="shrink-0 text-brand-charcoal/60" aria-label="Pinned">
            <PinIcon filled />
          </span>
        )}
      </div>
      {snippet && (
        <p className="mt-1 line-clamp-2 text-sm text-brand-ink-soft">
          {snippet}
        </p>
      )}
      <p className="mt-2 text-xs text-brand-ink-soft">
        {formatRelativeTime(conversation.updatedAt)}
      </p>
    </Link>
  );
}
