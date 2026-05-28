import { describe, it, expect } from "vitest";
import {
  allScopeKeys,
  bucketsFromCatalog,
  defaultUserScopes,
  effectiveScopes,
  isEntityAllowed,
  isViewAllowed,
  makeScopeCatalog,
  sanitizeScopes,
  scopeForEntity,
  scopeForView,
  type ScopeCatalog,
} from "@/lib/scopes";
import {
  DEFAULT_ENTITY_SCOPES,
  DEFAULT_SCOPES,
  DEFAULT_VIEW_SCOPES,
} from "@/lib/scope-defaults";

// Catalog tests work against a synthetic ScopeCatalog built from
// src/lib/scope-defaults.ts — the same seed the migration applies — so we
// validate the live shipping defaults without needing a DB. The functions
// under test are pure given a catalog, which makes them straightforward to
// unit-test independent of /admin/scopes mutations.

function buildCatalog(): ScopeCatalog {
  return makeScopeCatalog({
    scopes: DEFAULT_SCOPES.map((s, i) => ({ ...s, id: i + 1 })),
    views: DEFAULT_VIEW_SCOPES.map(([viewName, scopeKey]) => ({
      viewName,
      scopeKey,
    })),
    entities: DEFAULT_ENTITY_SCOPES.map((e) => ({
      area: e.area,
      resource: e.resource,
      scopeKey: e.scopeKey,
    })),
  });
}

describe("scopeForView (default catalog)", () => {
  const catalog = buildCatalog();

  it("buckets the parts master and item refs as items", () => {
    expect(scopeForView("p21_view_inv_mast", catalog)).toBe("items");
    expect(scopeForView("p21_view_item_category", catalog)).toBe("items");
    expect(scopeForView("p21_view_item_uom", catalog)).toBe("items");
  });

  it("buckets on-hand stock and locations as stock", () => {
    expect(scopeForView("p21_view_inv_loc", catalog)).toBe("stock");
    expect(scopeForView("p21_view_inv_bin", catalog)).toBe("stock");
    expect(scopeForView("p21_view_branch", catalog)).toBe("stock");
    expect(scopeForView("p21_view_location", catalog)).toBe("stock");
  });

  it("buckets customers, contacts, ship-tos and territories", () => {
    expect(scopeForView("p21_view_customer", catalog)).toBe("customers");
    expect(scopeForView("p21_view_contacts", catalog)).toBe("customers");
    expect(scopeForView("p21_view_address", catalog)).toBe("customers");
    expect(scopeForView("p21_view_ship_to", catalog)).toBe("customers");
    expect(scopeForView("p21_view_territory_x_customer", catalog)).toBe("sales");
  });

  it("splits invoice headers (sales-side AR) from sales-order headers", () => {
    expect(scopeForView("p21_view_oe_hdr", catalog)).toBe("sales");
    expect(scopeForView("p21_view_invoice_hdr", catalog)).toBe("invoices");
    expect(scopeForView("p21_view_invoice_line_taxes", catalog)).toBe(
      "invoices",
    );
  });

  it("job pricing is its own opt-in bucket", () => {
    expect(scopeForView("p21_view_job_price_hdr", catalog)).toBe("pricing");
    expect(scopeForView("p21_view_job_price_line", catalog)).toBe("pricing");
  });

  it("traceability covers serials, pallets and document-line allocations", () => {
    expect(scopeForView("p21_view_serial_number", catalog)).toBe(
      "traceability",
    );
    expect(scopeForView("p21_view_pallet_hdr", catalog)).toBe("traceability");
    expect(scopeForView("p21_view_document_line_lot", catalog)).toBe(
      "traceability",
    );
  });

  it("p21_view_lot lives in pricing, not traceability — it carries sku_cost", () => {
    // The lot view exposes per-lot cost basis (`sku_cost`), so it's filed
    // under the opt-in `pricing` bucket. Non-admin lot-tracking requires
    // explicit pricing access. Audit finding from 2026-05-27.
    expect(scopeForView("p21_view_lot", catalog)).toBe("pricing");
  });

  it("inbound: receipts, returns to vendor, RMA, adjustments", () => {
    expect(scopeForView("p21_view_inventory_receipts_hdr", catalog)).toBe(
      "inbound",
    );
    expect(scopeForView("p21_view_rma_receipt_hdr", catalog)).toBe("inbound");
    expect(scopeForView("p21_view_inv_adj_hdr", catalog)).toBe("inbound");
  });

  it("outbound: pick tickets, shipments, transfers, allocations, production", () => {
    expect(scopeForView("p21_view_oe_pick_ticket", catalog)).toBe("outbound");
    expect(scopeForView("p21_view_transfer_hdr", catalog)).toBe("outbound");
    expect(scopeForView("p21_view_shipment", catalog)).toBe("outbound");
    expect(scopeForView("p21_view_find_lot_allocations", catalog)).toBe(
      "outbound",
    );
    expect(scopeForView("p21_view_prod_order_hdr", catalog)).toBe("outbound");
  });

  it("purchasing covers vendors, POs and AP invoices", () => {
    expect(scopeForView("p21_view_vendor", catalog)).toBe("purchasing");
    expect(scopeForView("p21_view_supplier", catalog)).toBe("purchasing");
    expect(scopeForView("p21_view_po_hdr", catalog)).toBe("purchasing");
    expect(scopeForView("p21_view_apinv_hdr", catalog)).toBe("purchasing");
  });

  it("uncategorized views return null", () => {
    expect(scopeForView("p21_view_some_future_thing", catalog)).toBeNull();
    expect(scopeForView("p21_view_zzz", catalog)).toBeNull();
  });
});

describe("scopeForEntity (default catalog)", () => {
  const catalog = buildCatalog();

  it("area-only rules match every resource under the area", () => {
    expect(scopeForEntity("inventory", "v2/parts", catalog)).toBe("items");
    expect(scopeForEntity("sales", "orders", catalog)).toBe("sales");
    expect(scopeForEntity("purchasing", "purchaseorders", catalog)).toBe(
      "purchasing",
    );
  });

  it("exact area+resource rules win over no rule", () => {
    expect(scopeForEntity("entity", "customers", catalog)).toBe("customers");
    expect(scopeForEntity("entity", "contacts", catalog)).toBe("customers");
    expect(scopeForEntity("entity", "vendors", catalog)).toBe("purchasing");
  });

  it("returns null for unmapped areas (deny-by-default)", () => {
    expect(scopeForEntity("accounting", "gl", catalog)).toBeNull();
    expect(scopeForEntity("entity", "salesreps", catalog)).toBeNull();
  });
});

describe("effectiveScopes", () => {
  const catalog = buildCatalog();

  it("admin → 'all'", () => {
    expect(effectiveScopes("admin", null, catalog)).toBe("all");
    expect(effectiveScopes("admin", ["pricing"], catalog)).toBe("all");
  });

  it("revoked → []", () => {
    expect(effectiveScopes("revoked", null, catalog)).toEqual([]);
    expect(effectiveScopes("revoked", ["items"], catalog)).toEqual([]);
  });

  it("user with null override → tier defaults (everything operational, no pricing)", () => {
    const result = effectiveScopes("user", null, catalog);
    expect(result).toEqual(defaultUserScopes(catalog));
    expect(result).toContain("items");
    expect(result).toContain("sales");
    expect(result).not.toContain("pricing");
  });

  it("user with explicit override is honored", () => {
    expect(effectiveScopes("user", ["items"], catalog)).toEqual(["items"]);
  });

  it("user with empty override locks them out", () => {
    expect(effectiveScopes("user", [], catalog)).toEqual([]);
  });

  it("drops unknown scope names from the override (forward-compat)", () => {
    expect(effectiveScopes("user", ["items", "deleted_bucket"], catalog)).toEqual([
      "items",
    ]);
  });
});

describe("isViewAllowed", () => {
  const catalog = buildCatalog();
  const userDefault = effectiveScopes("user", null, catalog);

  it("admin bypasses", () => {
    const r = isViewAllowed("p21_view_job_price_hdr", "all", catalog);
    expect(r.ok).toBe(true);
  });

  it("default user can read operational views", () => {
    for (const v of [
      "p21_view_inv_mast",
      "p21_view_customer",
      "p21_view_oe_hdr",
      "p21_view_invoice_hdr",
      "p21_view_po_hdr",
    ]) {
      const r = isViewAllowed(v, userDefault, catalog);
      expect(r.ok, `expected ${v} allowed by default`).toBe(true);
    }
  });

  it("default user cannot read job pricing (sensitive opt-in)", () => {
    const r = isViewAllowed("p21_view_job_price_hdr", userDefault, catalog);
    expect(r.ok).toBe(false);
  });

  it("uncategorized view denied for non-admins (deny-by-default)", () => {
    const r = isViewAllowed("p21_view_zzz_unknown", userDefault, catalog);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("uncategorized");
  });

  it("scope-denied carries the required scope + label", () => {
    const r = isViewAllowed("p21_view_job_price_hdr", ["items"], catalog);
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "scope_denied") {
      expect(r.scope).toBe("pricing");
      expect(r.scopeLabel).toBe("Job pricing");
    } else {
      throw new Error("expected scope_denied");
    }
  });
});

describe("isEntityAllowed", () => {
  const catalog = buildCatalog();

  it("admin bypasses", () => {
    const r = isEntityAllowed("inventory", "v2/parts", "all", catalog);
    expect(r.ok).toBe(true);
  });

  it("default user can hit inventory entity routes via area-only rule", () => {
    const r = isEntityAllowed(
      "inventory",
      "v2/parts",
      effectiveScopes("user", null, catalog),
      catalog,
    );
    expect(r.ok).toBe(true);
  });

  it("default user cannot hit unmapped areas", () => {
    const r = isEntityAllowed(
      "accounting",
      "gl",
      effectiveScopes("user", null, catalog),
      catalog,
    );
    expect(r.ok).toBe(false);
  });
});

describe("sanitizeScopes", () => {
  const catalog = buildCatalog();

  it("returns null for null/undefined", () => {
    expect(sanitizeScopes(null, catalog)).toBeNull();
    expect(sanitizeScopes(undefined, catalog)).toBeNull();
  });

  it("returns null for non-array input", () => {
    expect(sanitizeScopes("items", catalog)).toBeNull();
    expect(sanitizeScopes(42, catalog)).toBeNull();
  });

  it("drops unknown keys, dedupes, preserves catalog order", () => {
    expect(
      sanitizeScopes(["pricing", "items", "ghost", "items"], catalog),
    ).toEqual(["items", "pricing"]);
  });

  it("empty array stays empty", () => {
    expect(sanitizeScopes([], catalog)).toEqual([]);
  });
});

describe("catalog hygiene (defaults)", () => {
  const catalog = buildCatalog();

  it("every default view's scope_key exists in DEFAULT_SCOPES", () => {
    const keys = new Set(DEFAULT_SCOPES.map((s) => s.key));
    for (const [v, k] of DEFAULT_VIEW_SCOPES) {
      expect(keys.has(k), `view ${v} maps to unknown scope ${k}`).toBe(true);
    }
  });

  it("every default entity's scope_key exists", () => {
    const keys = new Set(DEFAULT_SCOPES.map((s) => s.key));
    for (const e of DEFAULT_ENTITY_SCOPES) {
      expect(
        keys.has(e.scopeKey),
        `entity ${e.area}/${e.resource} maps to unknown scope ${e.scopeKey}`,
      ).toBe(true);
    }
  });

  it("bucketsFromCatalog returns scopes ordered by sortOrder", () => {
    const buckets = bucketsFromCatalog(catalog);
    expect(buckets.map((b) => b.key)).toEqual(allScopeKeys(catalog));
    expect(buckets[0].key).toBe("items"); // sortOrder 10 is the lowest
    expect(buckets[buckets.length - 1].key).toBe("purchasing"); // sortOrder 100
  });

  it("only `pricing` is opt-in (defaultForUser=false) — everything else operational", () => {
    const buckets = bucketsFromCatalog(catalog);
    const optIn = buckets.filter((b) => !b.defaultForUser).map((b) => b.key);
    expect(optIn).toEqual(["pricing"]);
  });
});
