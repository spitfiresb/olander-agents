import { describe, expect, test } from "vitest";
import { chunkText } from "@/lib/ai/chunk";

describe("chunkText", () => {
  test("returns nothing for empty/whitespace input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  \t ")).toEqual([]);
  });

  test("keeps a short document as a single chunk", () => {
    const out = chunkText("A short reference note.");
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ index: 0, text: "A short reference note." });
  });

  test("packs paragraphs that fit, splits those that don't", () => {
    // Window of 6 chars: each 4-char paragraph can't share a chunk (4+2+4 > 6).
    const out = chunkText("aaaa\n\nbbbb\n\ncccc", { maxChars: 6, overlapChars: 0 });
    expect(out.map((c) => c.text)).toEqual(["aaaa", "bbbb", "cccc"]);
    expect(out.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  test("combines small paragraphs under the window into one chunk", () => {
    const out = chunkText("aa\n\nbb", { maxChars: 50 });
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("aa\n\nbb");
  });

  test("hard-splits an oversized paragraph and never exceeds the window", () => {
    const para = "x".repeat(4000);
    const out = chunkText(para, { maxChars: 1500, overlapChars: 150 });
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.text.length).toBeLessThanOrEqual(1500);
    // Sequential indices.
    expect(out.map((c) => c.index)).toEqual(out.map((_, i) => i));
    // Overlap means consecutive windows share their boundary region.
    expect(out[0].text.length).toBe(1500);
  });
});
