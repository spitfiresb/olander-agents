import { describe, it, expect } from "vitest";
import {
  buildEmbedInput,
  embedInputHash,
  toVectorLiteral,
  VOYAGE_DIM,
} from "@/lib/ai/embeddings";

describe("buildEmbedInput", () => {
  it("renders the canonical 4-line shape for a fully-populated row", () => {
    const text = buildEmbedInput({
      item_id: "PN12345-01",
      item_desc: "100-PC M4 X 4 SOC SHOULDER SCREW SST",
      extended_desc: "3MM THREAD W/IFI-524 PATCH  SOLD BY BAG OF 100 PCS",
      sales_pricing_unit: "BG",
    });
    expect(text).toBe(
      [
        "SKU: PN12345-01",
        "Description: 100-PC M4 X 4 SOC SHOULDER SCREW SST",
        "Details: 3MM THREAD W/IFI-524 PATCH  SOLD BY BAG OF 100 PCS",
        "UOM: BG",
      ].join("\n"),
    );
  });

  it("omits extended_desc when it is the RoHS/Non-RoHS marker", () => {
    const a = buildEmbedInput({
      item_id: "X1",
      item_desc: "WIDGET",
      extended_desc: "RoHS",
      sales_pricing_unit: "EA",
    });
    expect(a).not.toContain("Details:");

    const b = buildEmbedInput({
      item_id: "X2",
      item_desc: "WIDGET",
      extended_desc: "Non-RoHS",
      sales_pricing_unit: "EA",
    });
    expect(b).not.toContain("Details:");
  });

  it("omits extended_desc when it is a pure numeric tolerance string", () => {
    const text = buildEmbedInput({
      item_id: "X1",
      item_desc: "PRECISION SHIM",
      extended_desc: ".0939-.0941",
      sales_pricing_unit: "EA",
    });
    expect(text).not.toContain("Details:");
  });

  it("omits extended_desc when it duplicates item_desc verbatim", () => {
    const text = buildEmbedInput({
      item_id: "X1",
      item_desc: "M4 STAINLESS WASHER",
      extended_desc: "M4 STAINLESS WASHER",
      sales_pricing_unit: "EA",
    });
    expect(text).not.toContain("Details:");
  });

  it("preserves a meaningful spelled-out extended_desc", () => {
    const text = buildEmbedInput({
      item_id: "6C100SFIS",
      item_desc: "6-32 X 1 SLOT FILL SST RoHS",
      extended_desc: "6-32 X 1 Slot Fillister Head Stainless Steel RoHS",
      sales_pricing_unit: "EA",
    });
    expect(text).toContain("Slot Fillister Head Stainless Steel");
  });

  it("omits missing optional fields cleanly", () => {
    const text = buildEmbedInput({
      item_id: ".032SW",
      item_desc: ".032 DIASAFETY WIRE 302 SST",
      extended_desc: null,
      sales_pricing_unit: "EA",
    });
    expect(text).toBe(
      ["SKU: .032SW", "Description: .032 DIASAFETY WIRE 302 SST", "UOM: EA"].join("\n"),
    );
  });

  it("never embeds a null SKU — the row would never be referenceable", () => {
    // item_id is required upstream (P21 enforces it). buildEmbedInput should
    // still tolerate odd inputs without crashing — the SKU line is always
    // present, even if other fields fall away.
    const text = buildEmbedInput({
      item_id: "X1",
      item_desc: null,
      extended_desc: null,
      sales_pricing_unit: null,
    });
    expect(text).toBe("SKU: X1");
  });
});

describe("embedInputHash", () => {
  it("is stable across calls with the same input", async () => {
    const text = "SKU: A\nDescription: B\nUOM: EA";
    const a = await embedInputHash(text);
    const b = await embedInputHash(text);
    expect(a).toBe(b);
  });

  it("differs when input changes", async () => {
    const a = await embedInputHash("SKU: A\nDescription: WASHER");
    const b = await embedInputHash("SKU: A\nDescription: SCREW");
    expect(a).not.toBe(b);
  });

  it("returns a 64-char hex sha256 digest", async () => {
    const h = await embedInputHash("anything");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("toVectorLiteral", () => {
  it("wraps a number array in brackets, comma-separated (pgvector format)", () => {
    expect(toVectorLiteral([1, 2.5, -3])).toBe("[1,2.5,-3]");
  });

  it("round-trips a 1024-dim array of the expected shape", () => {
    const arr = Array.from({ length: VOYAGE_DIM }, (_, i) => i / VOYAGE_DIM);
    const literal = toVectorLiteral(arr);
    expect(literal.startsWith("[")).toBe(true);
    expect(literal.endsWith("]")).toBe(true);
    const parsed = literal.slice(1, -1).split(",").map(Number);
    expect(parsed).toHaveLength(VOYAGE_DIM);
    expect(parsed[0]).toBe(0);
    expect(parsed[VOYAGE_DIM - 1]).toBeCloseTo((VOYAGE_DIM - 1) / VOYAGE_DIM);
  });
});
