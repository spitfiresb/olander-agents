import { describe, it, expect } from "vitest";
import {
  callerHasPricing,
  coerceRowsBySchema,
  isSensitiveColumn,
  parseNumeric,
  redactSensitiveRows,
} from "@/lib/ai/p21-fields";

describe("isSensitiveColumn", () => {
  it("flags cost / margin columns", () => {
    for (const c of [
      "moving_average_cost",
      "standard_cost",
      "sales_cost",
      "po_cost",
      "other_cost",
      "commission_cost",
      "cogs_amount",
      "gross_margin",
      "profit_percent",
      "order_cost_basis",
      "sku_cost",
      "unit_cost",
      "extended_cost",
    ]) {
      expect(isSensitiveColumn(c), c).toBe(true);
    }
  });

  it("leaves selling prices and operational columns alone", () => {
    for (const c of [
      "price1",
      "price10",
      "unit_price",
      "extended_price",
      "total_amount",
      "qty_on_hand",
      "qty_allocated",
      "item_desc",
      "customer_id",
      "order_no",
    ]) {
      expect(isSensitiveColumn(c), c).toBe(false);
    }
  });

  it("does not flag account-number / code / flag columns that carry no value", () => {
    for (const c of [
      "landed_cost_account_no",
      "cost_price_page_uid",
      "commission_cost_edited_flag",
      "cost_center_tracking_option",
      "landed_cost_included_cd",
    ]) {
      expect(isSensitiveColumn(c), c).toBe(false);
    }
  });
});

describe("redactSensitiveRows", () => {
  it("strips sensitive columns and reports what it removed", () => {
    const { rows, redactedColumns } = redactSensitiveRows([
      { item_id: "A1", price1: 10, moving_average_cost: 4, gross_margin: 6 },
      { item_id: "A2", price1: 20, moving_average_cost: 9, gross_margin: 11 },
    ]);
    expect(rows).toEqual([
      { item_id: "A1", price1: 10 },
      { item_id: "A2", price1: 20 },
    ]);
    expect(redactedColumns).toEqual(["gross_margin", "moving_average_cost"]);
  });

  it("is a no-op when no sensitive columns are present", () => {
    const input = [{ item_id: "A1", price1: 10, qty_on_hand: 5 }];
    const { rows, redactedColumns } = redactSensitiveRows(input);
    expect(rows).toEqual(input);
    expect(redactedColumns).toEqual([]);
  });
});

describe("coerceRowsBySchema", () => {
  it("coerces a numeric-typed column the proxy left as a string", () => {
    // oe_hdr.gross_margin is Decimal in the schema but the proxy's name regex
    // misses it, so it arrives as a string. We coerce by schema type.
    const [row] = coerceRowsBySchema("p21_view_oe_hdr", [
      { order_no: "S1", gross_margin: "1240.50", profit_percent: "34.5" },
    ]);
    expect(row.gross_margin).toBe(1240.5);
    expect(row.profit_percent).toBe(34.5);
  });

  it("never coerces a String-typed column, even if all-digits", () => {
    // invoice_hdr.customer_id is String upstream; coercing would drop leading
    // zeros and break the master-view lookup.
    const [row] = coerceRowsBySchema("p21_view_invoice_hdr", [
      { customer_id: "0123", total_amount: "500.00" },
    ]);
    expect(row.customer_id).toBe("0123");
    expect(row.total_amount).toBe(500);
  });

  it("returns rows unchanged for an unknown view", () => {
    const input = [{ a: "1" }];
    expect(coerceRowsBySchema("p21_view_not_real", input)).toBe(input);
  });
});

describe("parseNumeric", () => {
  it("parses numbers and numeric strings, strips thousands separators", () => {
    expect(parseNumeric(42)).toBe(42);
    expect(parseNumeric("42.5")).toBe(42.5);
    expect(parseNumeric("1,234.50")).toBe(1234.5);
    expect(parseNumeric("0.000000000000")).toBe(0);
  });

  it("returns null for non-numeric values", () => {
    expect(parseNumeric(null)).toBeNull();
    expect(parseNumeric("")).toBeNull();
    expect(parseNumeric("N")).toBeNull();
    expect(parseNumeric("PN12345-01")).toBeNull();
    expect(parseNumeric(undefined)).toBeNull();
  });
});

describe("callerHasPricing", () => {
  it("admins (all) and pricing-scoped users may see cost/margin", () => {
    expect(callerHasPricing("all")).toBe(true);
    expect(callerHasPricing(["pricing", "sales"])).toBe(true);
  });
  it("everyone else may not", () => {
    expect(callerHasPricing([])).toBe(false);
    expect(callerHasPricing(["sales", "stock"])).toBe(false);
  });
});
