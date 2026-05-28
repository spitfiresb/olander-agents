import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "../relative-time";

// Reference clock used across the tests. May 19 2026, mid-afternoon
// Pacific. All `iso` inputs are computed back from this so the bucket
// boundaries fire deterministically.
const NOW = new Date("2026-05-19T22:00:00.000Z");

function ago(ms: number) {
  return new Date(NOW.getTime() - ms).toISOString();
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatRelativeTime", () => {
  it("treats sub-minute deltas as 'just now'", () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe("just now");
    expect(formatRelativeTime(ago(30 * SECOND), NOW)).toBe("just now");
    expect(formatRelativeTime(ago(MINUTE - 1), NOW)).toBe("just now");
  });

  it("uses 'X min ago' between 1 min and 1 hour", () => {
    expect(formatRelativeTime(ago(MINUTE), NOW)).toBe("1 min ago");
    expect(formatRelativeTime(ago(59 * MINUTE), NOW)).toBe("59 min ago");
  });

  it("uses 'X hr ago' between 1 hour and 24 hours", () => {
    expect(formatRelativeTime(ago(HOUR), NOW)).toBe("1 hr ago");
    expect(formatRelativeTime(ago(23 * HOUR + 59 * MINUTE), NOW)).toBe(
      "23 hr ago",
    );
  });

  it("uses 'Yesterday' for the second 24-hour window", () => {
    expect(formatRelativeTime(ago(DAY), NOW)).toBe("Yesterday");
    expect(formatRelativeTime(ago(2 * DAY - MINUTE), NOW)).toBe("Yesterday");
  });

  it("uses 'X days ago' between 2 and 7 days", () => {
    expect(formatRelativeTime(ago(2 * DAY), NOW)).toBe("2 days ago");
    expect(formatRelativeTime(ago(6 * DAY), NOW)).toBe("6 days ago");
  });

  it("uses absolute month + day for older same-year dates", () => {
    // 10 days ago from May 19 = May 9
    expect(formatRelativeTime(ago(10 * DAY), NOW)).toBe("May 9");
  });

  it("uses absolute month + year for prior-year dates", () => {
    // 400 days ago from May 19 2026 lands in April 2025
    const out = formatRelativeTime(ago(400 * DAY), NOW);
    expect(out).toMatch(/^(Apr|Mar|May) 2025$/);
  });

  it("clamps future timestamps to 'just now'", () => {
    const future = new Date(NOW.getTime() + 5 * MINUTE).toISOString();
    expect(formatRelativeTime(future, NOW)).toBe("just now");
  });
});
