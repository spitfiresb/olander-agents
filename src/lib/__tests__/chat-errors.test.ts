import { describe, expect, test } from "vitest";
import { describeError, truncateQuery } from "@/lib/chat-errors";

// These are the pure extraction/truncation helpers behind logChatError. The DB
// write itself is fail-safe and not unit-tested here (it mirrors the existing
// toolCalls insert path); what matters is that a giant or weird thrown value
// can't bloat a row or crash the logger.

describe("describeError", () => {
  test("pulls name/message/stack off an Error", () => {
    const err = new TypeError("boom");
    const out = describeError(err);
    expect(out.name).toBe("TypeError");
    expect(out.message).toBe("boom");
    expect(out.stack).toContain("boom");
  });

  test("handles a thrown string", () => {
    const out = describeError("provider 503");
    expect(out).toEqual({ name: null, message: "provider 503", stack: null });
  });

  test("handles null / undefined without throwing", () => {
    expect(describeError(null)).toEqual({ name: null, message: null, stack: null });
    expect(describeError(undefined)).toEqual({ name: null, message: null, stack: null });
  });

  test("serializes a non-Error object", () => {
    const out = describeError({ status: 429, code: "insufficient_quota" });
    expect(out.message).toContain("insufficient_quota");
    expect(out.name).toBeNull();
  });

  test("truncates a huge message and marks it", () => {
    const out = describeError("x".repeat(5000));
    expect(out.message).not.toBeNull();
    expect(out.message!.length).toBeLessThan(5000);
    expect(out.message!.endsWith("…[truncated]")).toBe(true);
  });

  test("truncates a huge stack", () => {
    const err = new Error("e");
    err.stack = "frame\n".repeat(2000);
    const out = describeError(err);
    expect(out.stack!.endsWith("…[truncated]")).toBe(true);
  });

  test("does not append the marker to a short message", () => {
    expect(describeError("short").message).toBe("short");
  });
});

describe("truncateQuery", () => {
  test("passes through a normal query", () => {
    expect(truncateQuery("how many open orders?")).toBe("how many open orders?");
  });

  test("returns null for empty / nullish input", () => {
    expect(truncateQuery(null)).toBeNull();
    expect(truncateQuery(undefined)).toBeNull();
    expect(truncateQuery("")).toBeNull();
  });

  test("truncates an overlong query and marks it", () => {
    const out = truncateQuery("q".repeat(2000));
    expect(out!.length).toBeLessThan(2000);
    expect(out!.endsWith("…[truncated]")).toBe(true);
  });
});
