// Human-friendly relative time for the empty-state recent-chat cards.
// Reads like a person talks ("2 hr ago", "Yesterday", "May 12") and
// stops lying after a week — beyond that the absolute date is shorter
// to scan than "9 days ago".
//
// `now` is an injected parameter so tests can pin the comparison clock.
// Default to `new Date()` when called from the UI.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// en-US is intentional — Olander reps speak English. Pinning the locale
// keeps server-rendered + client-rendered output byte-identical so we
// don't fight hydration mismatches when SSR's locale differs from the
// browser's.
const SAME_YEAR_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});
const OTHER_YEAR_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
});

export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const elapsed = now.getTime() - then.getTime();

  // Future / clock skew → treat as just-happened so we never show "in 5 min".
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) {
    const m = Math.floor(elapsed / MINUTE);
    return `${m} min ago`;
  }
  if (elapsed < DAY) {
    const h = Math.floor(elapsed / HOUR);
    return `${h} hr ago`;
  }
  if (elapsed < 2 * DAY) return "Yesterday";
  if (elapsed < 7 * DAY) {
    const d = Math.floor(elapsed / DAY);
    return `${d} days ago`;
  }
  // Beyond a week — absolute date. Same calendar year drops the year
  // ("May 12"); different year shows month + year ("May 2025") since the
  // exact day matters less the older a chat gets.
  if (then.getFullYear() === now.getFullYear()) {
    return SAME_YEAR_FMT.format(then);
  }
  return OTHER_YEAR_FMT.format(then);
}
