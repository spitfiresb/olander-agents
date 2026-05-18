"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "./Logo";

// Fixed Olander Agents wordmark in the top-right corner of every page — except
// the chat itself (`/chat` and `/chat/<id>`), which has its own topbar wordmark,
// and the login screen (`/`), which already shows the wordmark front and center.
export function TopRightLogo() {
  const pathname = usePathname();
  const hide =
    pathname === "/" ||
    pathname === "/chat" ||
    /^\/chat\/[0-9a-fA-F-]{36}$/.test(pathname);
  if (hide) return null;

  return (
    <Link
      href="/chat"
      aria-label="Olander Agents — home"
      className="fixed right-5 top-4 z-50 flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2"
    >
      <Logo size="sm" />
      <span className="text-sm font-medium text-brand-charcoal">Agents</span>
    </Link>
  );
}
