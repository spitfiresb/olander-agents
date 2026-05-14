-- Data-access scopes — make the scope catalog editable from /admin/scopes
-- instead of living as hardcoded tables in src/lib/scopes.ts.
--
-- IF NOT EXISTS on every DDL so this migration is safe to re-run against an
-- already-migrated DB (matches the convention from 0005_sturdy_dorian_gray).
-- The seed inserts use ON CONFLICT DO NOTHING so admin customizations made
-- after the first run are preserved; only missing rows get filled in. To
-- wholesale rebuild defaults, use the "Reset to defaults" action in the
-- admin UI, which wipes and re-applies from src/lib/scope-defaults.ts.

CREATE TABLE IF NOT EXISTS "scope" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"defaultForUser" boolean DEFAULT false NOT NULL,
	"sortOrder" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scope_key_unique" UNIQUE("key")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "scope_view" (
	"viewName" text PRIMARY KEY NOT NULL,
	"scopeId" integer NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "scope_entity" (
	"area" text NOT NULL,
	"resource" text DEFAULT '' NOT NULL,
	"scopeId" integer NOT NULL,
	CONSTRAINT "scope_entity_area_resource_pk" PRIMARY KEY("area","resource")
);
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "scope_view" ADD CONSTRAINT "scope_view_scopeId_scope_id_fk"
		FOREIGN KEY ("scopeId") REFERENCES "public"."scope"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "scope_entity" ADD CONSTRAINT "scope_entity_scopeId_scope_id_fk"
		FOREIGN KEY ("scopeId") REFERENCES "public"."scope"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "scope_view_scope_idx" ON "scope_view"("scopeId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scope_entity_scope_idx" ON "scope_entity"("scopeId");
--> statement-breakpoint

-- Base 10-scope layout. Mirrors DEFAULT_SCOPES in src/lib/scope-defaults.ts —
-- keep in sync. `defaultForUser` is the only sensitive-vs-operational flag:
-- pricing is the one bucket off by default because it surfaces margin data.
INSERT INTO "scope" ("key","label","description","defaultForUser","sortOrder") VALUES
	('items',        'Items & catalog',     'Parts master, categories, units of measure, classes, substitutes, cross-references.', true,  10),
	('stock',        'Stock & locations',   'On-hand quantities by location, bins, branches, stock status.',                          true,  20),
	('customers',    'Customers',           'Customers, contacts, ship-to addresses, mailing addresses.',                             true,  30),
	('sales',        'Sales orders',        'Quotes, sales orders, order acknowledgments, service orders, sales territories.',         true,  40),
	('invoices',     'Invoices',            'AR invoices and tax lines.',                                                              true,  50),
	('pricing',      'Job pricing',         'Customer-specific contract pricing. Off by default — margin-sensitive.',                  false, 60),
	('traceability', 'Lot / serial / pallet','Chain-of-custody: lot detail, serial numbers, pallets, document-line allocations.',      true,  70),
	('inbound',      'Inbound ops',         'Inventory receipts, returns to vendor, RMA receipts, inventory adjustments.',             true,  80),
	('outbound',     'Outbound ops',        'Pick tickets, shipments, transfers, allocation finders, production orders.',              true,  90),
	('purchasing',   'Purchasing',          'Vendors, suppliers, purchase orders, AP invoices.',                                       true,  100)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint

-- View → scope. Mirrors DEFAULT_VIEW_SCOPES in src/lib/scope-defaults.ts.
-- Every view in data/p21-schema.json is mapped to exactly one scope here;
-- any view not present is uncategorized → denied for non-admins.
INSERT INTO "scope_view" ("viewName","scopeId")
SELECT v.view_name, s.id FROM (VALUES
	('p21_view_address','customers'),
	('p21_view_apinv_hdr','purchasing'),
	('p21_view_apinv_hdr_x_inventory_receipts','purchasing'),
	('p21_view_apinv_line','purchasing'),
	('p21_view_bin','stock'),
	('p21_view_bin_replenishment_process','stock'),
	('p21_view_bin_type','stock'),
	('p21_view_branch','stock'),
	('p21_view_class','items'),
	('p21_view_company','items'),
	('p21_view_contacts','customers'),
	('p21_view_contacts_x_links','customers'),
	('p21_view_customer','customers'),
	('p21_view_document_line_bin','traceability'),
	('p21_view_document_line_lot','traceability'),
	('p21_view_document_line_serial','traceability'),
	('p21_view_document_link','items'),
	('p21_view_document_link_area','items'),
	('p21_view_find_bin_allocations','outbound'),
	('p21_view_find_lot_allocations','outbound'),
	('p21_view_find_lot_bin_allocations','outbound'),
	('p21_view_find_serial_allocations','outbound'),
	('p21_view_find_tag_allocations','outbound'),
	('p21_view_find_transaction_allocations','outbound'),
	('p21_view_find_transfer_allocations','outbound'),
	('p21_view_find_transfer_shipment_allocations','outbound'),
	('p21_view_freight_code','items'),
	('p21_view_inv_accessory','items'),
	('p21_view_inv_adj_hdr','inbound'),
	('p21_view_inv_adj_line','inbound'),
	('p21_view_inv_bin','stock'),
	('p21_view_inv_loc','stock'),
	('p21_view_inv_loc_stock_status','stock'),
	('p21_view_inv_mast','items'),
	('p21_view_inv_mast_language','items'),
	('p21_view_inv_mast_x_restricted_class','items'),
	('p21_view_inv_sub','items'),
	('p21_view_inv_xref','items'),
	('p21_view_inventory_receipts_hdr','inbound'),
	('p21_view_inventory_receipts_line','inbound'),
	('p21_view_inventory_return_hdr','inbound'),
	('p21_view_inventory_return_line','inbound'),
	('p21_view_inventory_supplier','purchasing'),
	('p21_view_inventory_supplier_x_loc','purchasing'),
	('p21_view_invoice_hdr','invoices'),
	('p21_view_invoice_line','invoices'),
	('p21_view_invoice_line_taxes','invoices'),
	('p21_view_invoice_line_with_taxes','invoices'),
	('p21_view_item_catalog','items'),
	('p21_view_item_catalog_def','items'),
	('p21_view_item_catalog_def_detail','items'),
	('p21_view_item_category','items'),
	('p21_view_item_category_hierarchy','items'),
	('p21_view_item_category_x_class','items'),
	('p21_view_item_category_x_inv_mast','items'),
	('p21_view_item_uom','items'),
	('p21_view_job_price_bin','pricing'),
	('p21_view_job_price_customer_shipto','pricing'),
	('p21_view_job_price_hdr','pricing'),
	('p21_view_job_price_line','pricing'),
	('p21_view_language','items'),
	('p21_view_location','stock'),
	('p21_view_lot','traceability'),
	('p21_view_lot_bin_detail','traceability'),
	('p21_view_lot_bin_xref','traceability'),
	('p21_view_lot_detail','traceability'),
	('p21_view_oe_hdr','sales'),
	('p21_view_oe_hdr_rma','sales'),
	('p21_view_oe_line','sales'),
	('p21_view_oe_line_po','sales'),
	('p21_view_oe_line_rma','sales'),
	('p21_view_oe_line_schedule','sales'),
	('p21_view_oe_line_service','sales'),
	('p21_view_oe_line_service_labor','sales'),
	('p21_view_oe_line_service_part','sales'),
	('p21_view_oe_pick_ticket','outbound'),
	('p21_view_oe_pick_ticket_detail','outbound'),
	('p21_view_ord_ack_hdr','sales'),
	('p21_view_ord_ack_line','sales'),
	('p21_view_pallet_hdr','traceability'),
	('p21_view_pallet_hdr_transfer_receipt','traceability'),
	('p21_view_pallet_info','traceability'),
	('p21_view_pallet_line','traceability'),
	('p21_view_pick_ticket_bins','outbound'),
	('p21_view_po_hdr','purchasing'),
	('p21_view_po_line','purchasing'),
	('p21_view_po_line_schedule','purchasing'),
	('p21_view_po_schedule','purchasing'),
	('p21_view_prod_order_hdr','outbound'),
	('p21_view_prod_order_line','outbound'),
	('p21_view_prod_order_line_component','outbound'),
	('p21_view_prod_order_line_link','outbound'),
	('p21_view_product_group','items'),
	('p21_view_quote_hdr','sales'),
	('p21_view_quote_line','sales'),
	('p21_view_restricted_class','items'),
	('p21_view_rma_receipt_hdr','inbound'),
	('p21_view_rma_receipt_line','inbound'),
	('p21_view_serial_number','traceability'),
	('p21_view_serial_number_extd_info','traceability'),
	('p21_view_service_inv_mast','items'),
	('p21_view_ship_to','customers'),
	('p21_view_shipment','outbound'),
	('p21_view_supplier','purchasing'),
	('p21_view_territory','sales'),
	('p21_view_territory_grp','sales'),
	('p21_view_territory_x_customer','sales'),
	('p21_view_territory_x_ship_to','sales'),
	('p21_view_territory_x_territory_grp','sales'),
	('p21_view_transfer_hdr','outbound'),
	('p21_view_transfer_line','outbound'),
	('p21_view_transfer_lot','outbound'),
	('p21_view_transfer_serial','outbound'),
	('p21_view_transfer_shipment_hdr','outbound'),
	('p21_view_transfer_shipment_line','outbound'),
	('p21_view_vendor','purchasing'),
	('p21_view_workbench_find_priority_pick_users','outbound'),
	('pathguide_lot_number_attribute_view','traceability')
) AS v(view_name, scope_key)
JOIN "scope" s ON s."key" = v.scope_key
ON CONFLICT ("viewName") DO NOTHING;
--> statement-breakpoint

-- Entity routes. Empty resource = "all routes under this area"; non-empty =
-- exact match on area+resource.
INSERT INTO "scope_entity" ("area","resource","scopeId")
SELECT e.area, e.resource, s.id FROM (VALUES
	('inventory',  '',          'items'),
	('entity',     'customers', 'customers'),
	('entity',     'contacts',  'customers'),
	('entity',     'addresses', 'customers'),
	('entity',     'vendors',   'purchasing'),
	('sales',      '',          'sales'),
	('purchasing', '',          'purchasing')
) AS e(area, resource, scope_key)
JOIN "scope" s ON s."key" = e.scope_key
ON CONFLICT ("area","resource") DO NOTHING;
--> statement-breakpoint

-- Translate legacy scope keys (the old 7-bucket taxonomy in src/lib/scopes.ts
-- pre-0007) into the new 10-scope catalog so any member.dataScopes override
-- or mirrored user.dataScopes value keeps working. Legacy `inventory` was the
-- kitchen-sink bucket — split into items/stock/traceability/inbound/outbound.
-- Legacy `sales` split into sales/invoices/pricing. Legacy `vendors` and
-- `purchasing` both collapse to `purchasing`. `financials` and `hr_payroll`
-- matched zero views in the live schema, so they're dropped on translation
-- (no behavior change — they granted nothing).
UPDATE "member" m
SET "dataScopes" = (
	SELECT COALESCE(jsonb_agg(DISTINCT new_key), '[]'::jsonb)
	FROM jsonb_array_elements_text(m."dataScopes") AS elem(old_key)
	JOIN (VALUES
		('inventory','items'),('inventory','stock'),('inventory','traceability'),('inventory','inbound'),('inventory','outbound'),
		('customers','customers'),
		('sales','sales'),('sales','invoices'),('sales','pricing'),
		('vendors','purchasing'),
		('purchasing','purchasing')
	) AS map(o, new_key) ON map.o = elem.old_key
)
WHERE m."dataScopes" IS NOT NULL
  AND EXISTS (
	SELECT 1 FROM jsonb_array_elements_text(m."dataScopes") AS x(k)
	WHERE x.k IN ('inventory','customers','sales','vendors','purchasing','financials','hr_payroll')
  );
--> statement-breakpoint

UPDATE "user" u
SET "dataScopes" = (
	SELECT COALESCE(jsonb_agg(DISTINCT new_key), '[]'::jsonb)
	FROM jsonb_array_elements_text(u."dataScopes") AS elem(old_key)
	JOIN (VALUES
		('inventory','items'),('inventory','stock'),('inventory','traceability'),('inventory','inbound'),('inventory','outbound'),
		('customers','customers'),
		('sales','sales'),('sales','invoices'),('sales','pricing'),
		('vendors','purchasing'),
		('purchasing','purchasing')
	) AS map(o, new_key) ON map.o = elem.old_key
)
WHERE u."dataScopes" IS NOT NULL
  AND EXISTS (
	SELECT 1 FROM jsonb_array_elements_text(u."dataScopes") AS x(k)
	WHERE x.k IN ('inventory','customers','sales','vendors','purchasing','financials','hr_payroll')
  );
