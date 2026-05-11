import { describe, expect, test } from "vitest";
import {
  labelForToolPart,
  summarizeToolUsageForCitation,
} from "@/lib/ai/tool-labels";

describe("labelForToolPart", () => {
  test("maps inventory view to friendly label", () => {
    const { label } = labelForToolPart("viewsQuery", {
      viewName: "p21_view_inv_mast",
    });
    expect(label).toBe("Inventory search");
  });

  test("maps customer view to friendly label", () => {
    expect(
      labelForToolPart("viewsQuery", { viewName: "p21_view_customer" }).label,
    ).toBe("Customer search");
  });

  test("maps entity parts to detail label", () => {
    expect(
      labelForToolPart("entityGet", {
        area: "inventory",
        resource: "v2/parts",
        id: "PN12345-01",
      }).label,
    ).toBe("Part detail");
  });

  test("falls back to a generic label for unknown views", () => {
    const { label } = labelForToolPart("viewsQuery", {
      viewName: "p21_view_some_new_view",
    });
    expect(label).toBe("P21 search");
  });

  test("humanizes simple startswith filters", () => {
    const { sublabel } = labelForToolPart("viewsQuery", {
      viewName: "p21_view_inv_mast",
      filter: "startswith(item_id,'M10')",
    });
    expect(sublabel).toContain("M10");
  });
});

describe("summarizeToolUsageForCitation", () => {
  test("reports row count for viewsQuery", () => {
    const out = summarizeToolUsageForCitation(
      "viewsQuery",
      { viewName: "p21_view_inv_mast" },
      { rows: [{}, {}, {}], count: 3 },
    );
    expect(out).toMatch(/3 rows/);
  });

  test("reports a single record for entityGet", () => {
    const out = summarizeToolUsageForCitation(
      "entityGet",
      { area: "inventory", resource: "v2/parts", id: "x" },
      { item_id: "x" },
    );
    expect(out).toMatch(/v2\/parts/);
    expect(out).toMatch(/1 record/);
  });
});
