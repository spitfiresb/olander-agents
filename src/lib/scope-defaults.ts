// Default scope catalog — shipped as the base layout for the admin UI at
// /admin/scopes. The migration drizzle/0007_*.sql seeds these into the
// scope / scope_view / scope_entity tables on first run. The "Reset to
// defaults" action in the admin UI re-applies them by wiping and re-seeding,
// so this file IS the single source of truth — keep it and the SQL seed in
// sync.
//
// Bucketing was derived from the live P21 schema snapshot at
// data/p21-schema.json (118 views) plus the entity routes documented in
// docs/P21_Schema.md. Sensitive surfaces (margin-bearing job pricing) are
// opt-in (defaultForUser: false); everything operational defaults on.

export type ScopeDefault = {
  key: string;
  label: string;
  description: string;
  defaultForUser: boolean;
  sortOrder: number;
};

export const DEFAULT_SCOPES: ScopeDefault[] = [
  {
    key: "items",
    label: "Items & catalog",
    description:
      "Parts master, categories, units of measure, classes, substitutes, cross-references.",
    defaultForUser: true,
    sortOrder: 10,
  },
  {
    key: "stock",
    label: "Stock & locations",
    description:
      "On-hand quantities by location, bins, branches, stock status.",
    defaultForUser: true,
    sortOrder: 20,
  },
  {
    key: "customers",
    label: "Customers",
    description: "Customers, contacts, ship-to addresses, mailing addresses.",
    defaultForUser: true,
    sortOrder: 30,
  },
  {
    key: "sales",
    label: "Sales orders",
    description:
      "Quotes, sales orders, order acknowledgments, service orders, sales territories.",
    defaultForUser: true,
    sortOrder: 40,
  },
  {
    key: "invoices",
    label: "Invoices",
    description: "AR invoices and tax lines.",
    defaultForUser: true,
    sortOrder: 50,
  },
  {
    key: "pricing",
    label: "Job pricing",
    description:
      "Customer-specific contract pricing. Off by default — margin-sensitive.",
    defaultForUser: false,
    sortOrder: 60,
  },
  {
    key: "traceability",
    label: "Lot / serial / pallet",
    description:
      "Chain-of-custody: lot detail, serial numbers, pallets, document-line allocations.",
    defaultForUser: true,
    sortOrder: 70,
  },
  {
    key: "inbound",
    label: "Inbound ops",
    description:
      "Inventory receipts, returns to vendor, RMA receipts, inventory adjustments.",
    defaultForUser: true,
    sortOrder: 80,
  },
  {
    key: "outbound",
    label: "Outbound ops",
    description:
      "Pick tickets, shipments, transfers, allocation finders, production orders.",
    defaultForUser: true,
    sortOrder: 90,
  },
  {
    key: "purchasing",
    label: "Purchasing",
    description: "Vendors, suppliers, purchase orders, AP invoices.",
    defaultForUser: true,
    sortOrder: 100,
  },
];

// Every view in data/p21-schema.json mapped to exactly one scope key. New
// views (re-run scripts/droplet/dump-p21-schema.sh) that aren't in this list
// are uncategorized → denied for non-admins until an admin maps them in the
// UI.
export const DEFAULT_VIEW_SCOPES: ReadonlyArray<readonly [string, string]> = [
  ["p21_view_address", "customers"],
  ["p21_view_apinv_hdr", "purchasing"],
  ["p21_view_apinv_hdr_x_inventory_receipts", "purchasing"],
  ["p21_view_apinv_line", "purchasing"],
  ["p21_view_bin", "stock"],
  ["p21_view_bin_replenishment_process", "stock"],
  ["p21_view_bin_type", "stock"],
  ["p21_view_branch", "stock"],
  ["p21_view_class", "items"],
  ["p21_view_company", "items"],
  ["p21_view_contacts", "customers"],
  ["p21_view_contacts_x_links", "customers"],
  ["p21_view_customer", "customers"],
  ["p21_view_document_line_bin", "traceability"],
  ["p21_view_document_line_lot", "traceability"],
  ["p21_view_document_line_serial", "traceability"],
  ["p21_view_document_link", "items"],
  ["p21_view_document_link_area", "items"],
  ["p21_view_find_bin_allocations", "outbound"],
  ["p21_view_find_lot_allocations", "outbound"],
  ["p21_view_find_lot_bin_allocations", "outbound"],
  ["p21_view_find_serial_allocations", "outbound"],
  ["p21_view_find_tag_allocations", "outbound"],
  ["p21_view_find_transaction_allocations", "outbound"],
  ["p21_view_find_transfer_allocations", "outbound"],
  ["p21_view_find_transfer_shipment_allocations", "outbound"],
  ["p21_view_freight_code", "items"],
  ["p21_view_inv_accessory", "items"],
  ["p21_view_inv_adj_hdr", "inbound"],
  ["p21_view_inv_adj_line", "inbound"],
  ["p21_view_inv_bin", "stock"],
  ["p21_view_inv_loc", "stock"],
  ["p21_view_inv_loc_stock_status", "stock"],
  ["p21_view_inv_mast", "items"],
  ["p21_view_inv_mast_language", "items"],
  ["p21_view_inv_mast_x_restricted_class", "items"],
  ["p21_view_inv_sub", "items"],
  ["p21_view_inv_xref", "items"],
  ["p21_view_inventory_receipts_hdr", "inbound"],
  ["p21_view_inventory_receipts_line", "inbound"],
  ["p21_view_inventory_return_hdr", "inbound"],
  ["p21_view_inventory_return_line", "inbound"],
  ["p21_view_inventory_supplier", "purchasing"],
  ["p21_view_inventory_supplier_x_loc", "purchasing"],
  ["p21_view_invoice_hdr", "invoices"],
  ["p21_view_invoice_line", "invoices"],
  ["p21_view_invoice_line_taxes", "invoices"],
  ["p21_view_invoice_line_with_taxes", "invoices"],
  ["p21_view_item_catalog", "items"],
  ["p21_view_item_catalog_def", "items"],
  ["p21_view_item_catalog_def_detail", "items"],
  ["p21_view_item_category", "items"],
  ["p21_view_item_category_hierarchy", "items"],
  ["p21_view_item_category_x_class", "items"],
  ["p21_view_item_category_x_inv_mast", "items"],
  ["p21_view_item_uom", "items"],
  ["p21_view_job_price_bin", "pricing"],
  ["p21_view_job_price_customer_shipto", "pricing"],
  ["p21_view_job_price_hdr", "pricing"],
  ["p21_view_job_price_line", "pricing"],
  ["p21_view_language", "items"],
  ["p21_view_location", "stock"],
  ["p21_view_lot", "traceability"],
  ["p21_view_lot_bin_detail", "traceability"],
  ["p21_view_lot_bin_xref", "traceability"],
  ["p21_view_lot_detail", "traceability"],
  ["p21_view_oe_hdr", "sales"],
  ["p21_view_oe_hdr_rma", "sales"],
  ["p21_view_oe_line", "sales"],
  ["p21_view_oe_line_po", "sales"],
  ["p21_view_oe_line_rma", "sales"],
  ["p21_view_oe_line_schedule", "sales"],
  ["p21_view_oe_line_service", "sales"],
  ["p21_view_oe_line_service_labor", "sales"],
  ["p21_view_oe_line_service_part", "sales"],
  ["p21_view_oe_pick_ticket", "outbound"],
  ["p21_view_oe_pick_ticket_detail", "outbound"],
  ["p21_view_ord_ack_hdr", "sales"],
  ["p21_view_ord_ack_line", "sales"],
  ["p21_view_pallet_hdr", "traceability"],
  ["p21_view_pallet_hdr_transfer_receipt", "traceability"],
  ["p21_view_pallet_info", "traceability"],
  ["p21_view_pallet_line", "traceability"],
  ["p21_view_pick_ticket_bins", "outbound"],
  ["p21_view_po_hdr", "purchasing"],
  ["p21_view_po_line", "purchasing"],
  ["p21_view_po_line_schedule", "purchasing"],
  ["p21_view_po_schedule", "purchasing"],
  ["p21_view_prod_order_hdr", "outbound"],
  ["p21_view_prod_order_line", "outbound"],
  ["p21_view_prod_order_line_component", "outbound"],
  ["p21_view_prod_order_line_link", "outbound"],
  ["p21_view_product_group", "items"],
  ["p21_view_quote_hdr", "sales"],
  ["p21_view_quote_line", "sales"],
  ["p21_view_restricted_class", "items"],
  ["p21_view_rma_receipt_hdr", "inbound"],
  ["p21_view_rma_receipt_line", "inbound"],
  ["p21_view_serial_number", "traceability"],
  ["p21_view_serial_number_extd_info", "traceability"],
  ["p21_view_service_inv_mast", "items"],
  ["p21_view_ship_to", "customers"],
  ["p21_view_shipment", "outbound"],
  ["p21_view_supplier", "purchasing"],
  ["p21_view_territory", "sales"],
  ["p21_view_territory_grp", "sales"],
  ["p21_view_territory_x_customer", "sales"],
  ["p21_view_territory_x_ship_to", "sales"],
  ["p21_view_territory_x_territory_grp", "sales"],
  ["p21_view_transfer_hdr", "outbound"],
  ["p21_view_transfer_line", "outbound"],
  ["p21_view_transfer_lot", "outbound"],
  ["p21_view_transfer_serial", "outbound"],
  ["p21_view_transfer_shipment_hdr", "outbound"],
  ["p21_view_transfer_shipment_line", "outbound"],
  ["p21_view_vendor", "purchasing"],
  ["p21_view_workbench_find_priority_pick_users", "outbound"],
  ["pathguide_lot_number_attribute_view", "traceability"],
];

// Entity REST routes. `resource` empty = match all routes under the area.
// A non-empty resource is matched by exact area+resource pair.
export const DEFAULT_ENTITY_SCOPES: ReadonlyArray<{
  area: string;
  resource: string;
  scopeKey: string;
}> = [
  { area: "inventory", resource: "", scopeKey: "items" },
  { area: "entity", resource: "customers", scopeKey: "customers" },
  { area: "entity", resource: "contacts", scopeKey: "customers" },
  { area: "entity", resource: "addresses", scopeKey: "customers" },
  { area: "entity", resource: "vendors", scopeKey: "purchasing" },
  { area: "sales", resource: "", scopeKey: "sales" },
  { area: "purchasing", resource: "", scopeKey: "purchasing" },
];
