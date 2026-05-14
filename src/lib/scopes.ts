import type { Role } from "@/db/schema";

// Data-access scopes — the buckets an admin can grant per member.
//
// Every P21 view the chatbot can query is categorized into exactly one scope
// (see VIEW_RULES below). Calls in `viewsQuery` / `entityGet` go through
// isViewAllowed / isEntityAllowed with the caller's effective scopes; admins
// bypass entirely.
//
// Deny-by-default: anything that doesn't match a categorization rule is
// rejected for non-admins. A view that nobody has explicitly slotted into a
// scope is safer to lock down than to leak — add the rule, then re-deploy.

export type Scope =
  | "inventory"
  | "customers"
  | "sales"
  | "vendors"
  | "purchasing"
  | "financials"
  | "hr_payroll";

export type ScopeMeta = {
  label: string;
  description: string;
  // Whether a fresh non-admin member gets this scope when no per-member
  // override is set. Sensitive buckets (financials, payroll) are opt-in.
  defaultForUser: boolean;
};

export const SCOPES: Record<Scope, ScopeMeta> = {
  inventory: {
    label: "Inventory",
    description: "Parts catalog + on-hand stock by location.",
    defaultForUser: true,
  },
  customers: {
    label: "Customers",
    description: "Customer master, contacts, ship-to addresses.",
    defaultForUser: true,
  },
  sales: {
    label: "Sales orders",
    description: "Quotes, sales orders, invoices, order lines.",
    defaultForUser: true,
  },
  vendors: {
    label: "Vendors",
    description: "Vendor master, suppliers, AP invoice headers (basic).",
    defaultForUser: true,
  },
  purchasing: {
    label: "Purchasing",
    description: "Purchase orders and receipts.",
    defaultForUser: true,
  },
  financials: {
    label: "Financials",
    description:
      "AR / AP balances, general ledger, payments, customer credit, journals.",
    defaultForUser: false,
  },
  hr_payroll: {
    label: "HR & payroll",
    description: "Salesreps, employees, commissions, payroll.",
    defaultForUser: false,
  },
};

export const ALL_SCOPES = Object.keys(SCOPES) as Scope[];

export function defaultUserScopes(): Scope[] {
  return ALL_SCOPES.filter((s) => SCOPES[s].defaultForUser);
}

// View-name → scope rules. First match wins, so list the sensitive prefixes
// before the broader catch-alls (a `payroll` view that happens to start with
// `p21_view_employee_` must still classify as `hr_payroll`, not get caught by
// a wider rule). The patterns are intentionally permissive — every P21
// `p21_view_*` should resolve to exactly one scope. Anything that doesn't is
// denied for non-admins.
type ViewRule = { match: RegExp; scope: Scope };
const VIEW_RULES: ViewRule[] = [
  // Sensitive — payroll / employee / commission / salesrep tables.
  { match: /^p21_view_payroll/i, scope: "hr_payroll" },
  { match: /^p21_view_employee/i, scope: "hr_payroll" },
  { match: /^p21_view_salesrep/i, scope: "hr_payroll" },
  { match: /^p21_view_commission/i, scope: "hr_payroll" },

  // Sensitive — accounting, credit, payments, GL.
  { match: /^p21_view_ar_/i, scope: "financials" },
  { match: /^p21_view_ap_/i, scope: "financials" },
  { match: /^p21_view_gl_/i, scope: "financials" },
  { match: /^p21_view_journal/i, scope: "financials" },
  { match: /^p21_view_chart_of_accts/i, scope: "financials" },
  { match: /^p21_view_credit/i, scope: "financials" },
  { match: /^p21_view_.*payment/i, scope: "financials" },
  { match: /^p21_view_exchange_rate/i, scope: "financials" },

  // Sales / orders / invoices (kept above generic customer rules in case any
  // view name starts with `p21_view_oe_customer_*` etc.).
  { match: /^p21_view_oe_/i, scope: "sales" },
  { match: /^p21_view_invoice/i, scope: "sales" },
  { match: /^p21_view_quote/i, scope: "sales" },
  { match: /^p21_view_opportunity/i, scope: "sales" },
  { match: /^p21_view_ord_ack/i, scope: "sales" },
  { match: /^p21_view_job_price/i, scope: "sales" },
  { match: /^p21_view_territory/i, scope: "sales" },

  // Purchasing.
  { match: /^p21_view_po_/i, scope: "purchasing" },
  { match: /^p21_view_purchase/i, scope: "purchasing" },
  { match: /^p21_view_receipts/i, scope: "purchasing" },

  // Vendors / suppliers / AP invoices (the document headers, not balances).
  { match: /^p21_view_vendor/i, scope: "vendors" },
  { match: /^p21_view_supplier/i, scope: "vendors" },
  { match: /^p21_view_apinv/i, scope: "vendors" },

  // Customers (people / addresses / contacts).
  { match: /^p21_view_customer/i, scope: "customers" },
  { match: /^p21_view_contact/i, scope: "customers" },
  { match: /^p21_view_address/i, scope: "customers" },
  { match: /^p21_view_ship_to/i, scope: "customers" },

  // Inventory — items, catalog, and the warehouse-operations surface that
  // sits adjacent to it (bins, lots, pallets, serials, transfers, shipments,
  // RMA receipts, production orders, document/allocation finders).
  { match: /^p21_view_inv_/i, scope: "inventory" },
  { match: /^p21_view_inventory/i, scope: "inventory" },
  { match: /^p21_view_item/i, scope: "inventory" },
  { match: /^p21_view_uom/i, scope: "inventory" },
  { match: /^p21_view_bin/i, scope: "inventory" },
  { match: /^p21_view_lot/i, scope: "inventory" },
  { match: /^p21_view_pallet/i, scope: "inventory" },
  { match: /^p21_view_serial_number/i, scope: "inventory" },
  { match: /^p21_view_transfer/i, scope: "inventory" },
  { match: /^p21_view_shipment/i, scope: "inventory" },
  { match: /^p21_view_pick_ticket/i, scope: "inventory" },
  { match: /^p21_view_rma_receipt/i, scope: "inventory" },
  { match: /^p21_view_find_/i, scope: "inventory" },
  { match: /^p21_view_document_/i, scope: "inventory" },
  { match: /^p21_view_prod_order/i, scope: "inventory" },
  { match: /^p21_view_service_inv_mast/i, scope: "inventory" },
  // Workbench is a generic UI word; pin to the one current view so a future
  // `p21_view_workbench_*` that turns out to be sensitive (e.g. credit-hold
  // queues) is uncategorized → denied for non-admins until explicitly mapped.
  { match: /^p21_view_workbench_find_priority_pick_users$/i, scope: "inventory" },

  // Reference dimensions (branches, companies, languages, freight codes,
  // class/product-group lookups). Low-sensitivity static tables; folded into
  // inventory so the existing admin UI doesn't need a new scope for ~8 views
  // nobody is asking to gate separately.
  //
  // The four rules with `$` anchors below are pinned to the exact current
  // view names because their bare English prefixes (`class`, `company`,
  // `branch`) could absorb sensitive future views like
  // `p21_view_class_credit_terms` or `p21_view_branch_ar_balance`. Future
  // compounds must be explicitly categorized — deny-by-default protects us.
  { match: /^p21_view_branch$/i, scope: "inventory" },
  { match: /^p21_view_company$/i, scope: "inventory" },
  { match: /^p21_view_class$/i, scope: "inventory" },
  { match: /^p21_view_language/i, scope: "inventory" },
  { match: /^p21_view_location/i, scope: "inventory" },
  { match: /^p21_view_product_group/i, scope: "inventory" },
  { match: /^p21_view_restricted_class/i, scope: "inventory" },
  { match: /^p21_view_freight_code/i, scope: "inventory" },
];

export function scopeForView(viewName: string): Scope | null {
  for (const r of VIEW_RULES) {
    if (r.match.test(viewName)) return r.scope;
  }
  return null;
}

// Entity REST routes ( /api/<area>/<resource>/<id> ) → scope. Keys are
// `${area}/${resource}` with `/` preserved as-is so `inventory/v2/parts` maps
// cleanly. Matched by exact prefix on the area+resource string.
type EntityRule = { prefix: string; scope: Scope };
const ENTITY_RULES: EntityRule[] = [
  // Inventory.
  { prefix: "inventory/", scope: "inventory" },

  // Customer / contact / address.
  { prefix: "entity/customers", scope: "customers" },
  { prefix: "entity/contacts", scope: "customers" },
  { prefix: "entity/addresses", scope: "customers" },

  // Vendors.
  { prefix: "entity/vendors", scope: "vendors" },

  // Sales.
  { prefix: "sales/", scope: "sales" },

  // Purchasing.
  { prefix: "purchasing/", scope: "purchasing" },

  // Accounting → financials.
  { prefix: "accounting/", scope: "financials" },
];

export function scopeForEntity(area: string, resource: string): Scope | null {
  const key = `${area.toLowerCase()}/${resource.toLowerCase()}`;
  for (const r of ENTITY_RULES) {
    if (key.startsWith(r.prefix)) return r.scope;
  }
  return null;
}

export type EffectiveScopes = "all" | Scope[];

// Resolve what the caller is actually allowed to touch. Admins bypass the
// whole list ("all"); revoked sees nothing; everyone else gets either their
// per-member override or the tier default.
export function effectiveScopes(
  role: Role,
  customScopes: string[] | null | undefined,
): EffectiveScopes {
  if (role === "admin") return "all";
  if (role === "revoked") return [];
  if (customScopes == null) return defaultUserScopes();
  // Drop any unknown scope strings (forward-compat: if a scope is deleted
  // from code but still sits in the DB row, treat it as absent rather than
  // throwing — the user just loses that bucket until the row is updated).
  const known = customScopes.filter((s): s is Scope =>
    (ALL_SCOPES as string[]).includes(s),
  );
  return known;
}

export type AllowDecision =
  | { ok: true }
  | { ok: false; reason: "uncategorized"; resource: string }
  | { ok: false; reason: "scope_denied"; resource: string; scope: Scope };

export function isViewAllowed(
  viewName: string,
  scopes: EffectiveScopes,
): AllowDecision {
  if (scopes === "all") return { ok: true };
  const scope = scopeForView(viewName);
  if (scope === null) {
    return { ok: false, reason: "uncategorized", resource: viewName };
  }
  if (scopes.includes(scope)) return { ok: true };
  return { ok: false, reason: "scope_denied", resource: viewName, scope };
}

export function isEntityAllowed(
  area: string,
  resource: string,
  scopes: EffectiveScopes,
): AllowDecision {
  if (scopes === "all") return { ok: true };
  const scope = scopeForEntity(area, resource);
  const key = `${area}/${resource}`;
  if (scope === null) {
    return { ok: false, reason: "uncategorized", resource: key };
  }
  if (scopes.includes(scope)) return { ok: true };
  return { ok: false, reason: "scope_denied", resource: key, scope };
}
