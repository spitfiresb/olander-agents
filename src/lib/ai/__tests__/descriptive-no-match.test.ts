import { describe, it, expect } from "vitest";
import { descriptiveNoMatchHint } from "@/lib/ai/tools";

// Regression: "Stock check on 1/4-20 stainless lock nuts" returned 0 rows
// because the model wrote substringof('LOCK NUT'/'STAINLESS', item_desc)
// against p21_view_inv_mast — a literal text match that misses P21's
// abbreviated descriptions ('LOCKNUT', 'SST') for a part we stock 6,731 of.
// The hint fires on the symptom (a whiffed item_desc text filter) and steers
// the model to searchCatalog. See docs/TESTING.md § P21 (descriptive-query routing).
describe("descriptiveNoMatchHint", () => {
  const lockNutFilter =
    "substringof('LOCK NUT', item_desc) and substringof('1/4-20', item_desc) " +
    "and substringof('STAINLESS', item_desc) and delete_flag eq 'N'";

  it("fires on a 0-row substringof(item_desc) filter and mentions searchCatalog", () => {
    const hint = descriptiveNoMatchHint(lockNutFilter, 0);
    expect(hint).toBeTruthy();
    expect(hint).toMatch(/searchCatalog/);
  });

  it("matches regardless of quote contents or spacing", () => {
    expect(descriptiveNoMatchHint("substringof('SHCS',item_desc)", 0)).toBeTruthy();
    expect(
      descriptiveNoMatchHint("substringof( 'anti-seize' , item_desc )", 0),
    ).toBeTruthy();
  });

  it("does NOT fire when rows were returned", () => {
    expect(descriptiveNoMatchHint(lockNutFilter, 4)).toBeNull();
  });

  it("does NOT fire on non-description filters that happen to be empty", () => {
    expect(
      descriptiveNoMatchHint("qty_on_hand gt 0 and location_id eq 101", 0),
    ).toBeNull();
    expect(descriptiveNoMatchHint("item_id eq '25CLNTS'", 0)).toBeNull();
  });

  it("does NOT fire on an absent filter", () => {
    expect(descriptiveNoMatchHint(undefined, 0)).toBeNull();
  });

  it("does not false-positive on a column that merely contains the substring 'item_desc'", () => {
    // A substringof over a different column must not trip the item_desc guard.
    expect(
      descriptiveNoMatchHint("substringof('X', extended_desc)", 0),
    ).toBeNull();
  });
});
