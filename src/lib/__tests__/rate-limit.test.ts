import { describe, expect, test } from "vitest";
import { checkRateLimit } from "@/lib/rate-limit";

describe("checkRateLimit", () => {
  test("allows up to capacity bursts, then rejects", () => {
    const key = `burst-${Math.random()}`;
    const limit = { capacity: 3, refillPerSec: 0 };
    expect(checkRateLimit(key, limit).allowed).toBe(true);
    expect(checkRateLimit(key, limit).allowed).toBe(true);
    expect(checkRateLimit(key, limit).allowed).toBe(true);
    const blocked = checkRateLimit(key, limit);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  test("isolates by key", () => {
    const a = `iso-a-${Math.random()}`;
    const b = `iso-b-${Math.random()}`;
    const limit = { capacity: 1, refillPerSec: 0 };
    expect(checkRateLimit(a, limit).allowed).toBe(true);
    expect(checkRateLimit(a, limit).allowed).toBe(false);
    expect(checkRateLimit(b, limit).allowed).toBe(true);
  });

  test("reports a resetSeconds when blocked", () => {
    const key = `reset-${Math.random()}`;
    const limit = { capacity: 1, refillPerSec: 1 };
    checkRateLimit(key, limit); // consume
    const blocked = checkRateLimit(key, limit);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      // With refill 1/sec, recovery should be within a couple seconds.
      expect(blocked.resetSeconds).toBeGreaterThan(0);
      expect(blocked.resetSeconds).toBeLessThanOrEqual(3);
    }
  });
});
