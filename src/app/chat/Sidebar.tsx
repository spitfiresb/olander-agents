"use client";

import Link from "next/link";
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  CloseIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
} from "@/components/icons";
import { Wordmark } from "@/components/Wordmark";

export type ConversationSummary = {
  id: string;
  title: string;
  updatedAt: string;
  pinnedAt: string | null;
};

type Props = {
  conversations: ConversationSummary[];
  activeId: string | null;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onNewChat: () => void;
  onDelete?: (id: string) => void;
  onTogglePin?: (id: string, nextPinned: boolean) => void;
  onRename?: (id: string, nextTitle: string) => Promise<void> | void;
  // When the drawer wraps this in mobile, clicking a row should close the
  // drawer. Desktop passes undefined and the row just navigates.
  onRowSelect?: () => void;
};

const DAY_MS = 24 * 60 * 60 * 1000;

type Group = { label: string; rows: ConversationSummary[] };

function groupConversations(rows: ConversationSummary[]): Group[] {
  const now = Date.now();
  const pinned: ConversationSummary[] = [];
  const buckets: Record<string, ConversationSummary[]> = {
    Today: [],
    Yesterday: [],
    "Last 7 days": [],
    Older: [],
  };
  for (const row of rows) {
    if (row.pinnedAt) {
      pinned.push(row);
      continue;
    }
    const updated = new Date(row.updatedAt).getTime();
    const ageDays = (now - updated) / DAY_MS;
    if (ageDays < 1) buckets["Today"].push(row);
    else if (ageDays < 2) buckets["Yesterday"].push(row);
    else if (ageDays < 7) buckets["Last 7 days"].push(row);
    else buckets["Older"].push(row);
  }
  const out: Group[] = [];
  if (pinned.length > 0) {
    pinned.sort((a, b) => {
      const aT = a.pinnedAt ? new Date(a.pinnedAt).getTime() : 0;
      const bT = b.pinnedAt ? new Date(b.pinnedAt).getTime() : 0;
      return bT - aT;
    });
    out.push({ label: "Pinned", rows: pinned });
  }
  for (const [label, list] of Object.entries(buckets)) {
    if (list.length > 0) out.push({ label, rows: list });
  }
  return out;
}

export function Sidebar({
  conversations,
  activeId,
  searchQuery,
  onSearchChange,
  onNewChat,
  onDelete,
  onTogglePin,
  onRename,
  onRowSelect,
}: Props) {
  const isSearching = searchQuery.trim().length > 0;
  const groups = isSearching
    ? [{ label: "Results", rows: conversations }]
    : groupConversations(conversations);

  return (
    <aside className="flex h-full w-full shrink-0 flex-col bg-brand-charcoal lg:w-64">
      <div className="px-5 pb-4 pt-5">
        <Link
          href="/"
          aria-label="Olander Agents — back to home"
          className="inline-block rounded-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-charcoal"
        >
          <Wordmark variant="topbar" />
        </Link>
      </div>

      <div className="space-y-2 px-3 pb-3">
        <button
          type="button"
          onClick={onNewChat}
          className="flex h-10 w-full items-center gap-2 rounded-md border border-white/15 bg-white/5 px-3 text-sm font-medium text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-charcoal"
        >
          <PlusIcon />
          New chat
        </button>
        <SidebarSearch value={searchQuery} onChange={onSearchChange} />
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-2">
        {groups.length === 0 ? (
          isSearching ? (
            <p className="px-2 pt-2 text-xs leading-relaxed text-white/40">
              No chats match &ldquo;{searchQuery.trim()}&rdquo;.
            </p>
          ) : (
            <p className="px-2 text-xs leading-relaxed text-white/40">
              Your conversations will appear here as you use the assistant.
            </p>
          )
        ) : (
          groups.map((group) => (
            <div key={group.label} className="mb-3">
              <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-white/50">
                {group.label}
              </div>
              <ul>
                {group.rows.map((row) => (
                  <ConversationRow
                    key={row.id}
                    row={row}
                    isActive={row.id === activeId}
                    onDelete={onDelete}
                    onTogglePin={onTogglePin}
                    onRename={onRename}
                    onRowSelect={onRowSelect}
                  />
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
          onClick={onRowSelect}
        >
          Help
        </Link>
        <Link
          href="/status"
          className="block rounded-md px-2 py-1.5 text-xs text-white/60 transition-colors hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-charcoal"
          onClick={onRowSelect}
        >
          Service status
        </Link>
      </div>
    </aside>
  );
}

function SidebarSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="relative block">
      <span className="sr-only">Search chats</span>
      <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-white/40">
        <SearchIcon />
      </span>
      <input
        type="search"
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Escape" && value.length > 0) {
            e.preventDefault();
            onChange("");
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder="Search chats"
        className="h-9 w-full rounded-md border border-white/15 bg-white/5 pl-8 pr-2 text-sm text-white placeholder:text-white/40 focus:border-white/40 focus:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-charcoal"
      />
    </label>
  );
}

function ConversationRow({
  row,
  isActive,
  onDelete,
  onTogglePin,
  onRename,
  onRowSelect,
}: {
  row: ConversationSummary;
  isActive: boolean;
  onDelete?: (id: string) => void;
  onTogglePin?: (id: string, nextPinned: boolean) => void;
  onRename?: (id: string, nextTitle: string) => Promise<void> | void;
  onRowSelect?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const isPinned = !!row.pinnedAt;

  if (editing && onRename) {
    return (
      <li className="relative">
        <RenameInput
          initial={row.title}
          onCommit={async (next) => {
            const trimmed = next.trim();
            if (trimmed && trimmed !== row.title) {
              await onRename(row.id, trimmed);
            }
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      </li>
    );
  }

  return (
    <li className="group relative flex items-center">
      <Link
        href={`/chat/${row.id}`}
        onClick={onRowSelect}
        className={`flex min-w-0 flex-1 items-center gap-1.5 truncate rounded-md py-1.5 pl-2 pr-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-charcoal ${
          isActive
            ? "bg-white/10 text-white"
            : "text-white/70 hover:bg-white/5 hover:text-white"
        }`}
        title={row.title}
      >
        {isPinned && (
          <span
            aria-label="Pinned"
            className="shrink-0 text-white/70"
          >
            <PinIcon filled />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">{row.title}</span>
      </Link>

      <div className="absolute right-1 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        {onTogglePin && (
          <button
            type="button"
            onClick={() => onTogglePin(row.id, !isPinned)}
            aria-label={isPinned ? `Unpin ${row.title}` : `Pin ${row.title}`}
            className="flex h-6 w-6 items-center justify-center rounded text-white/60 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            <PinIcon filled={isPinned} />
          </button>
        )}
        {onRename && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label={`Rename ${row.title}`}
            className="flex h-6 w-6 items-center justify-center rounded text-white/60 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            <PencilIcon />
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            onClick={() => onDelete(row.id)}
            aria-label={`Delete ${row.title}`}
            className="flex h-6 w-6 items-center justify-center rounded text-white/60 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            <TrashIcon />
          </button>
        )}
      </div>
    </li>
  );
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (next: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Auto-focus + select-all when entering edit mode so typing replaces the
    // existing title cleanly. setState-in-effect is intentional via ref-focus.
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      await onCommit(value);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="block">
      <input
        ref={ref}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          // Treat blur as commit-on-change, cancel-on-no-change so a
          // distracted user doesn't lose their edit by clicking away.
          if (value.trim() && value !== initial) {
            void onCommit(value);
          } else {
            onCancel();
          }
        }}
        disabled={saving}
        maxLength={120}
        className="block w-full rounded-md border border-white/40 bg-white/10 py-1.5 pl-2 pr-2 text-sm text-white outline-none focus:border-white/60 disabled:opacity-50"
      />
    </form>
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

// Re-export the close icon so the mobile drawer can co-locate imports if it
// chooses; not used internally by the sidebar.
export { CloseIcon };
