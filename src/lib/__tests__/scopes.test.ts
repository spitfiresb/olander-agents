import { describe, it, expect } from "vitest";
import {
  ALL_SCOPES,
  SCOPES,
  defaultUserScopes,
  effectiveScopes,
  isEntityAllowed,
  isViewAllowed,
  scopeForEntity,
  scopeForView,
  type Scope,
} from "@/lib/scopes";

describe("scopeForView", () => {
  it("buckets known inventory views", () => {
    expect(scopeForView("p21_view_inv_mast")).toBe("inventory");
    expect(scopeForView("p21_view_inv_loc")).toBe("inventory");
    expect(scopeForView("p21_view_item_warehouse")).toBe("inventory");
  });

  it("buckets customer / contact / address as customers", () => {
    expect(scopeForView("p21_view_customer")).toBe("customers");
    expect(scopeForView("p21_view_contacts")).toBe("customers");
    expect(scopeForView("p21_view_address")).toBe("customers");
    expect(scopeForView("p21_view_ship_to")).toBe("customers");
  });

  it("buckets sales orders and invoices as sales", () => {
    expect(scopeForView("p21_view_oe_hdr")).toBe("sales");
    expect(scopeForView("p21_view_oe_line")).toBe("sales");
    expect(scopeForView("p21_view_invoice_hdr")).toBe("sales");
    expect(scopeForView("p21_view_quote_hdr")).toBe("sales");
  });

  it("buckets order acknowledgments, job pricing, and territory as sales", () => {
    expect(scopeForView("p21_view_ord_ack_hdr")).toBe("sales");
    expect(scopeForView("p21_view_ord_ack_line")).toBe("sales");
    expect(scopeForView("p21_view_job_price_hdr")).toBe("sales");
    expect(scopeForView("p21_view_job_price_line")).toBe("sales");
    expect(scopeForView("p21_view_territory")).toBe("sales");
    expect(scopeForView("p21_view_territory_x_customer")).toBe("sales");
  });

  it("buckets warehouse operations (bins, lots, pallets, serials, transfers) as inventory", () => {
    expect(scopeForView("p21_view_bin")).toBe("inventory");
    expect(scopeForView("p21_view_bin_replenishment_process")).toBe("inventory");
    expect(scopeForView("p21_view_lot")).toBe("inventory");
    expect(scopeForView("p21_view_lot_bin_detail")).toBe("inventory");
    expect(scopeForView("p21_view_pallet_hdr")).toBe("inventory");
    expect(scopeForView("p21_view_serial_number")).toBe("inventory");
    expect(scopeForView("p21_view_serial_number_extd_info")).toBe("inventory");
    expect(scopeForView("p21_view_transfer_hdr")).toBe("inventory");
    expect(scopeForView("p21_view_transfer_shipment_line")).toBe("inventory");
    expect(scopeForView("p21_view_shipment")).toBe("inventory");
    expect(scopeForView("p21_view_pick_ticket_bins")).toBe("inventory");
    expect(scopeForView("p21_view_rma_receipt_hdr")).toBe("inventory");
  });

  it("buckets document allocations, production orders, and reference dimensions as inventory", () => {
    expect(scopeForView("p21_view_find_lot_allocations")).toBe("inventory");
    expect(scopeForView("p21_view_find_transfer_shipment_allocations")).toBe(
      "inventory",
    );
    expect(scopeForView("p21_view_document_line_bin")).toBe("inventory");
    expect(scopeForView("p21_view_document_link")).toBe("inventory");
    expect(scopeForView("p21_view_prod_order_hdr")).toBe("inventory");
    expect(scopeForView("p21_view_prod_order_line_component")).toBe("inventory");
    expect(scopeForView("p21_view_branch")).toBe("inventory");
    expect(scopeForView("p21_view_company")).toBe("inventory");
    expect(scopeForView("p21_view_freight_code")).toBe("inventory");
    expect(scopeForView("p21_view_product_group")).toBe("inventory");
    expect(scopeForView("p21_view_workbench_find_priority_pick_users")).toBe(
      "inventory",
    );
  });

  it("distinguishes inv_ from invoice (the invoice rule must not catch inv_mast)", () => {
    expect(scopeForView("p21_view_inv_mast")).toBe("inventory");
    expect(scopeForView("p21_view_invoice_line")).toBe("sales");
  });

  it("transfer rule catches transfer_shipment_* without leaking to plain shipment classification", () => {
    expect(scopeForView("p21_view_transfer_shipment_hdr")).toBe("inventory");
    expect(scopeForView("p21_view_shipment")).toBe("inventory");
  });

  it("buckets vendors and AP invoice headers as vendors", () => {
    expect(scopeForView("p21_view_vendor")).toBe("vendors");
    expect(scopeForView("p21_view_supplier")).toBe("vendors");
    expect(scopeForView("p21_view_apinv_hdr")).toBe("vendors");
  });

  it("buckets POs and receipts as purchasing", () => {
    expect(scopeForView("p21_view_po_hdr")).toBe("purchasing");
    expect(scopeForView("p21_view_po_line")).toBe("purchasing");
    expect(scopeForView("p21_view_receipts")).toBe("purchasing");
  });

  it("buckets AR / AP / GL / payments / credit as financials", () => {
    expect(scopeForView("p21_view_ar_open_items")).toBe("financials");
    expect(scopeForView("p21_view_ap_check")).toBe("financials");
    expect(scopeForView("p21_view_gl_account")).toBe("financials");
    expect(scopeForView("p21_view_journal_hdr")).toBe("financials");
    expect(scopeForView("p21_view_chart_of_accts")).toBe("financials");
    expect(scopeForView("p21_view_credit_card")).toBe("financials");
    expect(scopeForView("p21_view_invoice_payment")).toBe("financials");
  });

  it("buckets payroll / salesreps / commissions as hr_payroll", () => {
    expect(scopeForView("p21_view_payroll_summary")).toBe("hr_payroll");
    expect(scopeForView("p21_view_employee")).toBe("hr_payroll");
    expect(scopeForView("p21_view_salesrep")).toBe("hr_payroll");
    expect(scopeForView("p21_view_commission_rate")).toBe("hr_payroll");
  });

  it("returns null for unknown views", () => {
    expect(scopeForView("p21_view_some_random_thing")).toBeNull();
    expect(scopeForView("p21_view_zzz")).toBeNull();
  });
});

describe("scopeForEntity", () => {
  it("buckets entity routes", () => {
    expect(scopeForEntity("inventory", "v2/parts")).toBe("inventory");
    expect(scopeForEntity("entity", "customers")).toBe("customers");
    expect(scopeForEntity("entity", "contacts")).toBe("customers");
    expect(scopeForEntity("entity", "vendors")).toBe("vendors");
    expect(scopeForEntity("sales", "orders")).toBe("sales");
    expect(scopeForEntity("purchasing", "purchaseorders")).toBe("purchasing");
    expect(scopeForEntity("accounting", "gl")).toBe("financials");
  });

  it("returns null for unmapped areas", () => {
    expect(scopeForEntity("service", "serviceorders")).toBeNull();
  });
});

describe("effectiveScopes", () => {
  it("admin → 'all'", () => {
    expect(effectiveScopes("admin", null)).toBe("all");
    expect(effectiveScopes("admin", ["financials"])).toBe("all");
  });

  it("revoked → []", () => {
    expect(effectiveScopes("revoked", null)).toEqual([]);
    expect(effectiveScopes("revoked", ["inventory"])).toEqual([]);
  });

  it("user with null override → tier defaults (non-sensitive buckets)", () => {
    const result = effectiveScopes("user", null);
    expect(result).toEqual(defaultUserScopes());
    expect(result).not.toContain("financials");
    expect(result).not.toContain("hr_payroll");
  });

  it("user with explicit override is honored", () => {
    expect(effectiveScopes("user", ["inventory"])).toEqual(["inventory"]);
  });

  it("user with empty override locks them out", () => {
    expect(effectiveScopes("user", [])).toEqual([]);
  });

  it("drops unknown scope names from the override (forward-compat)", () => {
    expect(effectiveScopes("user", ["inventory", "made_up"])).toEqual([
      "inventory",
    ]);
  });
});

describe("isViewAllowed", () => {
  const userDefault = effectiveScopes("user", null);

  it("admin bypasses", () => {
    const r = isViewAllowed("p21_view_payroll_summary", "all");
    expect(r.ok).toBe(true);
  });

  it("default user can read inventory, customers, sales, vendors, purchasing", () => {
    const okViews = [
      "p21_view_inv_mast",
      "p21_view_customer",
      "p21_view_oe_hdr",
      "p21_view_vendor",
      "p21_view_po_hdr",
    ];
    for (const v of okViews) {
      const r = isViewAllowed(v, userDefault);
      expect(r.ok, `expected ${v} allowed by default`).toBe(true);
    }
  });

  it("default user cannot read financials or payroll", () => {
    const denied = ["p21_view_ar_open_items", "p21_view_payroll_summary"];
    for (const v of denied) {
      const r = isViewAllowed(v, userDefault);
      expect(r.ok, `expected ${v} denied by default`).toBe(false);
    }
  });

  it("uncategorized view denied for non-admins (deny-by-default)", () => {
    const r = isViewAllowed("p21_view_zzz_unknown", userDefault);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("uncategorized");
  });

  it("scope-denied carries the required scope on the error", () => {
    const r = isViewAllowed("p21_view_payroll_summary", ["inventory"]);
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "scope_denied") {
      expect(r.scope).toBe("hr_payroll");
    } else {
      throw new Error("expected scope_denied");
    }
  });
});

describe("isEntityAllowed", () => {
  it("admin bypasses", () => {
    const r = isEntityAllowed("accounting", "gl", "all");
    expect(r.ok).toBe(true);
  });

  it("default user can hit inventory entity routes", () => {
    const r = isEntityAllowed(
      "inventory",
      "v2/parts",
      effectiveScopes("user", null),
    );
    expect(r.ok).toBe(true);
  });

  it("default user cannot hit accounting entity routes", () => {
    const r = isEntityAllowed("accounting", "gl", effectiveScopes("user", null));
    expect(r.ok).toBe(false);
  });
});

describe("scope catalog hygiene", () => {
  it("every scope has metadata", () => {
    for (const s of ALL_SCOPES) {
      expect(SCOPES[s]).toBeDefined();
      expect(SCOPES[s].label).toBeTruthy();
    }
  });

  it("defaultUserScopes contains only flagged defaults", () => {
    const defaults = new Set<Scope>(defaultUserScopes());
    for (const s of ALL_SCOPES) {
      expect(defaults.has(s)).toBe(SCOPES[s].defaultForUser);
    }
  });
});
