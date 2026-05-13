import Link from "next/link";

// "← Back to …" link used at the top-left of the admin pages. Plain text by
// default; on hover/focus a soft gray pill fades in behind it. The `-ml-3`
// pulls the padded hit-area left so the text still lines up with the heading
// below; the padding is always present so nothing shifts on hover.
export function BackLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="-ml-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm text-brand-ink-soft transition-colors hover:bg-brand-charcoal/10 hover:text-brand-charcoal focus-visible:bg-brand-charcoal/10 focus-visible:text-brand-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
    >
      <span aria-hidden>←</span>
      {children}
    </Link>
  );
}
