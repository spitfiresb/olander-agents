"use client";

import Link from "next/link";
import { PlusIcon } from "@/components/icons";
import { Wordmark } from "@/components/Wordmark";

export type ConversationSummary = {
  id: string;
  title: string;
  updatedAt: string; // ISO timestamp from /api/conversations
};

type Props = {
  conversations: ConversationSummary[];
  activeId: string | null;
  onNewChat: () => void;
  onDelete?: (id: string) => void;
};

const DAY_MS = 24 * 60 * 60 * 1000;

type Group = { label: string; rows: ConversationSummary[] };

function groupConversations(rows: ConversationSummary[]): Group[] {
  const now = Date.now();
  const buckets: Record<string, ConversationSummary[]> = {
    Today: [],
    Yesterday: [],
    "Last 7 days": [],
    Older: [],
  };
  for (const row of rows) {
    const updated = new Date(row.updatedAt).getTime();
    const ageDays = (now - updated) / DAY_MS;
    if (ageDays < 1) buckets["Today"].push(row);
    else if (ageDays < 2) buckets["Yesterday"].push(row);
    else if (ageDays < 7) buckets["Last 7 days"].push(row);
    else buckets["Older"].push(row);
  }
  return Object.entries(buckets)
    .filter(([, rows]) => rows.length > 0)
    .map(([label, rows]) => ({ label, rows }));
}

export function Sidebar({ conversations, activeId, onNewChat, onDelete }: Props) {
  const groups = groupConversations(conversations);

  return (
    <aside className="hidden h-full w-64 shrink-0 flex-col bg-brand-charcoal lg:flex">
      <div className="px-5 pb-4 pt-5">
        <Link
          href="/"
          aria-label="Olander Agents — back to home"
          className="inline-block rounded-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-charcoal"
        >
          <Wordmark variant="topbar" />
        </Link>
      </div>

      <div className="px-3 pb-4">
        <button
          type="button"
          onClick={onNewChat}
          className="flex h-10 w-full items-center gap-2 rounded-md border border-white/15 bg-white/5 px-3 text-sm font-medium text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-charcoal"
        >
          <PlusIcon />
          New chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-2">
        {groups.length === 0 ? (
          <p className="px-2 text-xs leading-relaxed text-white/40">
            Your conversations will appear here as you use the assistant.
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="mb-3">
              <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-white/50">
                {group.label}
              </div>
              <ul>
                {group.rows.map((row) => (
                  <li
                    key={row.id}
                    className="group relative flex items-center"
                  >
                    <Link
                      href={`/chat/${row.id}`}
                      className={`block flex-1 truncate rounded-md py-1.5 pl-2 pr-8 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-charcoal ${
                        row.id === activeId
                          ? "bg-white/10 text-white"
                          : "text-white/70 hover:bg-white/5 hover:text-white"
                      }`}
                      title={row.title}
                    >
                      {row.title}
                    </Link>
                    {onDelete && (
                      <button
                        type="button"
                        onClick={() => onDelete(row.id)}
                        aria-label={`Delete ${row.title}`}
                        className="absolute right-1 flex h-6 w-6 items-center justify-center rounded text-white/40 opacity-0 transition-opacity hover:text-white focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 group-hover:opacity-100"
                      >
                        <TrashIcon />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-white/10 px-3 py-3">
        <Link
          href="/chat/help"
          className="block rounded-md px-2 py-1.5 text-xs text-white/60 transition-colors hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-charcoal"
        >
          Help
        </Link>
        <Link
          href="/status"
          className="block rounded-md px-2 py-1.5 text-xs text-white/60 transition-colors hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-charcoal"
        >
          Service status
        </Link>
      </div>
    </aside>
  );
}

function TrashIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 4h10" />
      <path d="M5 4V2.5A.5.5 0 0 1 5.5 2h5a.5.5 0 0 1 .5.5V4" />
      <path d="M4 4l1 9.5a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1L12 4" />
    </svg>
  );
}
