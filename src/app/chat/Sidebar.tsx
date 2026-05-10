"use client";

import Link from "next/link";
import { PlusIcon } from "@/components/icons";
import { Wordmark } from "@/components/Wordmark";

export function Sidebar({ onNewChat }: { onNewChat: () => void }) {
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

      <div className="flex-1 overflow-y-auto px-3">
        <div className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-wider text-white/50">
          Today
        </div>
        <p className="px-2 text-xs leading-relaxed text-white/40">
          Your conversations will appear here once chat history is enabled.
        </p>
      </div>

      <div className="border-t border-white/10 px-3 py-3">
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
