import { describe, expect, test } from "vitest";
import { extractSearchText } from "@/lib/conversations";

describe("extractSearchText", () => {
  test("joins text from multiple text parts", () => {
    const parts = [
      { type: "text", text: "Find part SKU 8501-22" },
      { type: "text", text: "in stock?" },
    ];
    expect(extractSearchText(parts)).toBe("Find part SKU 8501-22 in stock?");
  });

  test("ignores tool parts", () => {
    const parts = [
      { type: "text", text: "Open orders for ACME" },
      {
        type: "tool-viewsQuery",
        input: { viewName: "p21_view_oe_hdr" },
        output: { rows: [], count: 0 },
      },
      { type: "text", text: "Any open?" },
    ];
    expect(extractSearchText(parts)).toBe("Open orders for ACME Any open?");
  });

  test("returns empty for non-array input", () => {
    expect(extractSearchText(null)).toBe("");
    expect(extractSearchText(undefined)).toBe("");
    expect(extractSearchText("just a string")).toBe("");
    expect(extractSearchText({ type: "text", text: "x" })).toBe("");
  });

  test("skips text parts without a string body", () => {
    const parts = [
      { type: "text", text: 42 },
      { type: "text" },
      { type: "text", text: "kept" },
    ];
    expect(extractSearchText(parts)).toBe("kept");
  });

  test("trims and drops whitespace-only text parts", () => {
    const parts = [
      { type: "text", text: "  hello   " },
      { type: "text", text: "   " },
      { type: "text", text: "world" },
    ];
    expect(extractSearchText(parts)).toBe("hello world");
  });

  test("returns empty for an empty parts array", () => {
    expect(extractSearchText([])).toBe("");
  });
});
