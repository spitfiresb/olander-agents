import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { scopeEntities, scopeViews, scopes as scopesTable } from "@/db/schema";
import type { Role } from "@/db/schema";

// Data-access scopes — editable from /admin/scopes, stored as data in the
// `scope`, `scope_view`, and `scope_entity` tables. The base 10-scope layout
// is seeded by drizzle/0007_*.sql and mirrored in src/lib/scope-defaults.ts.
//
// Callers load a snapshot via loadScopeCatalog() once per request and pass it
// into the allow checks. Three small SELECTs over <200 rows total — keep it
// simple, no process-level cache.
//
// Deny-by-default: any P21 view or entity route that doesn't match an entry
// in scope_view / scope_entity is rejected for non-admins. Admins bypass.

// Scope keys are runtime data, not a TypeScript literal union. Treated as a
// plain string alias so DB-shaped data flows through without churn. Validate
// against ScopeCatalog.scopes at the boundary.
export type Scope = string;

export type ScopeMeta = {
  id: number;
  key: string;
  label: string;
  description: string;
  defaultForUser: boolean;
  sortOrder: number;
};

export type ScopeCatalog = {
  scopes: Map<string, ScopeMeta>; // key → meta
  viewToScope: Map<string, string>; // view_name → scope_key
  entityToScope: Map<string, string>; // "area/resource" or "area/" → scope_key
};

// Plain serializable shape of the catalog's user-facing scope list. Use this
// for passing scope metadata into client components — ScopeCatalog itself
// holds Maps, which Next.js can't ship across the server/client boundary.
export type ScopeBucket = {
  key: string;
  label: string;
  description: string;
  defaultForUser: boolean;
};

export function bucketsFromCatalog(catalog: ScopeCatalog): ScopeBucket[] {
  return Array.from(catalog.scopes.values())
    .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))
    .map(({ key, label, description, defaultForUser }) => ({
      key,
      label,
      description,
      defaultForUser,
    }));
}

export async function loadScopeCatalog(): Promise<ScopeCatalog> {
  const [scopeRows, viewRows, entityRows] = await Promise.all([
    db
      .select()
      .from(scopesTable)
      .orderBy(asc(scopesTable.sortOrder), asc(scopesTable.key)),
    db
      .select({
        viewName: scopeViews.viewName,
        scopeKey: scopesTable.key,
      })
      .from(scopeViews)
      .innerJoin(scopesTable, eq(scopeViews.scopeId, scopesTable.id)),
    db
      .select({
        area: scopeEntities.area,
        resource: scopeEntities.resource,
        scopeKey: scopesTable.key,
      })
      .from(scopeEntities)
      .innerJoin(scopesTable, eq(scopeEntities.scopeId, scopesTable.id)),
  ]);

  const scopes = new Map<string, ScopeMeta>();
  for (const r of scopeRows) {
    scopes.set(r.key, {
      id: r.id,
      key: r.key,
      label: r.label,
      description: r.description,
      defaultForUser: r.defaultForUser,
      sortOrder: r.sortOrder,
    });
  }
  const viewToScope = new Map<string, string>();
  for (const r of viewRows) viewToScope.set(r.viewName, r.scopeKey);

  const entityToScope = new Map<string, string>();
  for (const r of entityRows) {
    entityToScope.set(`${r.area.toLowerCase()}/${r.resource.toLowerCase()}`, r.scopeKey);
  }

  return { scopes, viewToScope, entityToScope };
}

// Build a ScopeCatalog from in-memory data — handy for tests that don't want
// to spin up a DB, and for the "preview" of a Reset to Defaults dialog.
export function makeScopeCatalog(input: {
  scopes: ScopeMeta[];
  views: { viewName: string; scopeKey: string }[];
  entities: { area: string; resource: string; scopeKey: string }[];
}): ScopeCatalog {
  const scopes = new Map<string, ScopeMeta>();
  for (const s of input.scopes) scopes.set(s.key, s);
  const viewToScope = new Map<string, string>();
  for (const v of input.views) viewToScope.set(v.viewName, v.scopeKey);
  const entityToScope = new Map<string, string>();
  for (const e of input.entities) {
    entityToScope.set(`${e.area.toLowerCase()}/${e.resource.toLowerCase()}`, e.scopeKey);
  }
  return { scopes, viewToScope, entityToScope };
}

export function allScopeKeys(catalog: ScopeCatalog): string[] {
  return Array.from(catalog.scopes.values())
    .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))
    .map((s) => s.key);
}

export function defaultUserScopes(catalog: ScopeCatalog): string[] {
  return Array.from(catalog.scopes.values())
    .filter((s) => s.defaultForUser)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))
    .map((s) => s.key);
}

// Drop any scope keys that aren't in the catalog — forward-compat if a scope
// is renamed/removed but legacy rows still carry the old key. De-dupes and
// preserves the catalog's display order so output is stable.
export function sanitizeScopes(
  input: unknown,
  catalog: ScopeCatalog,
): string[] | null {
  if (input === null || input === undefined) return null;
  if (!Array.isArray(input)) return null;
  const seen = new Set<string>();
  for (const x of input) {
    if (typeof x === "string" && catalog.scopes.has(x)) seen.add(x);
  }
  return allScopeKeys(catalog).filter((k) => seen.has(k));
}

export type EffectiveScopes = "all" | string[];

// Resolve what the caller is actually allowed to touch. Admins bypass the
// whole list ("all"); revoked sees nothing; everyone else gets either their
// per-member override or the tier default. The catalog is the source of truth
// for both the default set and which keys are still valid.
export function effectiveScopes(
  role: Role,
  customScopes: string[] | null | undefined,
  catalog: ScopeCatalog,
): EffectiveScopes {
  if (role === "admin") return "all";
  if (role === "revoked") return [];
  if (customScopes == null) return defaultUserScopes(catalog);
  return customScopes.filter((s) => catalog.scopes.has(s));
}

export function scopeForView(
  viewName: string,
  catalog: ScopeCatalog,
): string | null {
  return catalog.viewToScope.get(viewName) ?? null;
}

export function scopeForEntity(
  area: string,
  resource: string,
  catalog: ScopeCatalog,
): string | null {
  const lcArea = area.toLowerCase();
  const lcRes = resource.toLowerCase();
  // Exact area+resource match first, then the area-wide rule (resource="").
  const exact = catalog.entityToScope.get(`${lcArea}/${lcRes}`);
  if (exact) return exact;
  return catalog.entityToScope.get(`${lcArea}/`) ?? null;
}

export type AllowDecision =
  | { ok: true }
  | { ok: false; reason: "uncategorized"; resource: string }
  | {
      ok: false;
      reason: "scope_denied";
      resource: string;
      scope: string;
      scopeLabel: string;
    };

export function isViewAllowed(
  viewName: string,
  scopes: EffectiveScopes,
  catalog: ScopeCatalog,
): AllowDecision {
  if (scopes === "all") return { ok: true };
  const scope = scopeForView(viewName, catalog);
  if (scope === null) {
    return { ok: false, reason: "uncategorized", resource: viewName };
  }
  if (scopes.includes(scope)) return { ok: true };
  return {
    ok: false,
    reason: "scope_denied",
    resource: viewName,
    scope,
    scopeLabel: catalog.scopes.get(scope)?.label ?? scope,
  };
}

export function isEntityAllowed(
  area: string,
  resource: string,
  scopes: EffectiveScopes,
  catalog: ScopeCatalog,
): AllowDecision {
  if (scopes === "all") return { ok: true };
  const scope = scopeForEntity(area, resource, catalog);
  const key = `${area}/${resource}`;
  if (scope === null) {
    return { ok: false, reason: "uncategorized", resource: key };
  }
  if (scopes.includes(scope)) return { ok: true };
  return {
    ok: false,
    reason: "scope_denied",
    resource: key,
    scope,
    scopeLabel: catalog.scopes.get(scope)?.label ?? scope,
  };
}
