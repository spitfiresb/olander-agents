import { describe, expect, test } from "vitest";
import { deriveTitleFromText } from "@/lib/conversations";

describe("deriveTitleFromText", () => {
  test("collapses whitespace", () => {
    expect(deriveTitleFromText("hello    world\nthere")).toBe(
      "hello world there",
    );
  });

  test("falls back to a sentinel for empty input", () => {
    expect(deriveTitleFromText("   ")).toBe("Untitled chat");
    expect(deriveTitleFromText("")).toBe("Untitled chat");
  });

  test("truncates over 60 chars with an ellipsis", () => {
    const long = "a".repeat(120);
    const out = deriveTitleFromText(long);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith("…")).toBe(true);
  });

  test("keeps short titles intact", () => {
    expect(deriveTitleFromText("ACME stainless orders")).toBe(
      "ACME stainless orders",
    );
  });
});
