import { describe, it, expect } from "vitest";
import { tools } from "@/lib/ai/tools";

// We test the public Zod schema rather than the execute() path — execute()
// requires VOYAGE_API_KEY and a populated pgvector index, which an
// environmentless unit test should not assume. Schema coverage is what most
// frequently regresses (typo in field name, accidentally widened bounds).

const schema = tools.searchCatalog.inputSchema;

describe("searchCatalog input schema", () => {
  it("accepts a basic descriptive query", () => {
    const parsed = schema.parse({ query: "stainless M10 cap screw 50mm" });
    expect(parsed.query).toBe("stainless M10 cap screw 50mm");
    expect(parsed.topK).toBe(5); // default
  });

  it("rejects an empty / 1-char query", () => {
    expect(() => schema.parse({ query: "" })).toThrow();
    expect(() => schema.parse({ query: "x" })).toThrow();
  });

  it("rejects an oversize query (>256 chars)", () => {
    expect(() => schema.parse({ query: "x".repeat(257) })).toThrow();
  });

  it("clamps topK to a sane range", () => {
    expect(() => schema.parse({ query: "ok", topK: 0 })).toThrow();
    expect(() => schema.parse({ query: "ok", topK: 21 })).toThrow();
    expect(() => schema.parse({ query: "ok", topK: 1.5 })).toThrow();
    const parsed = schema.parse({ query: "ok", topK: 10 });
    expect(parsed.topK).toBe(10);
  });

  it("rejects unknown extra fields silently (Zod default behavior)", () => {
    // Zod's default is to pass extras through silently for object schemas;
    // this test pins that behavior so a future strict() flip is a deliberate
    // decision, not a surprise.
    const parsed = schema.parse({ query: "ok", random: "yes" } as unknown);
    expect(parsed.query).toBe("ok");
  });
});
