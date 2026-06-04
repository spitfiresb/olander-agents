// Canonical demo queries — every entry was audited against live P21 data via
// the droplet proxy + Qdrant catalog: each returns a substantive, demo-worthy
// result today. This is the single source for both:
//   - the suggestion chips on the empty chat screen (src/app/chat/EmptyState.tsx)
//   - the end-to-end eval that smokes the full model→tools→P21 path (scripts/eval.ts)
// Keeping them unified means the eval always exercises exactly what users click.
//
// Choices that took data to settle:
//   - "31C100SHCS" (5/16-18 X 1 SOC CAP SST) has multi-warehouse stock
//     (2,265 at HQ + 183 elsewhere), so "across all warehouses" shows a spread.
//     PN12345-01 from the system-prompt examples comes back 0 everywhere.
//   - "last 30 days" / "last 6 months" windows instead of "today" / "this month":
//     P21's most-recent activity in our test dataset trails the calendar by
//     1-2 weeks, so narrower windows risked 0-row results.
//
// No aggregation-only prompts (viewsQuery has no $apply/groupby).
// No price-bearing prompts (the `pricing` scope is opt-in for non-admins).
export const SUGGESTION_POOL = [
  "What size helicoil goes in a 3/8-16 hole?",
  "Do we have any M10 1.25 socket head cap screws in stock?",
  "What parts do we stock the most of?",
  "Who carries bronze cap screws?",
  "On-hand for 31C100SHCS across all warehouses",
  "Find a 5/16-18 stainless flange nut",
  "Stock check on 1/4-20 stainless lock nuts",
  "Open sales orders shipping this week",
  "Open POs landing in the next 14 days",
  "Past-due invoices from the last 6 months",
  "Open sales orders from the last 30 days",
  "Customers added in the last 30 days",
] as const;
