import { promises as fs } from "node:fs";
import path from "node:path";
import { asc, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  members,
  scopeViews,
  scopes as scopesTable,
} from "@/db/schema";

// Page data for /admin/scopes. Loaded server-side per request — three small
// queries plus a one-time read of the bundled schema snapshot to find views
// that don't have a scope yet.

export type ScopeRow = {
  id: number;
  key: string;
  label: string;
  description: string;
  defaultForUser: boolean;
  sortOrder: number;
  viewCount: number;
  memberCount: number; // how many members reference this key in dataScopes
};

export type ScopesPageData = {
  scopes: ScopeRow[];
  // scope_key → views currently mapped to it (sorted alphabetically)
  assignments: Record<string, string[]>;
  // P21 views that aren't in any scope — denied for non-admins
  unassignedViews: string[];
  // view_name → compact metadata for the hover tooltip on chips. Built from
  // data/p21-schema.json once at process boot; <10kB total.
  viewMeta: Record<string, ViewMeta>;
};

export type ViewMeta = {
  columnCount: number;
  // First five column names — gives enough flavor in the tooltip that a rep
  // can confirm "yes this is the parts master" without round-tripping.
  sampleColumns: string[];
};

let cachedSchemaViews: string[] | null = null;
let cachedViewMeta: Record<string, ViewMeta> | null = null;

async function readSchema(): Promise<{
  names: string[];
  meta: Record<string, ViewMeta>;
}> {
  if (cachedSchemaViews && cachedViewMeta) {
    return { names: cachedSchemaViews, meta: cachedViewMeta };
  }
  const file = path.join(process.cwd(), "data", "p21-schema.json");
  const raw = await fs.readFile(file, "utf8");
  const parsed = JSON.parse(raw) as Array<{
    name: string;
    columns: Array<{ name: string }>;
  }>;
  cachedSchemaViews = parsed.map((v) => v.name).sort();
  cachedViewMeta = Object.fromEntries(
    parsed.map((v) => [
      v.name,
      {
        columnCount: v.columns.length,
        sampleColumns: v.columns.slice(0, 5).map((c) => c.name),
      },
    ]),
  );
  return { names: cachedSchemaViews, meta: cachedViewMeta };
}

export async function loadScopesPageData(): Promise<ScopesPageData> {
  const [scopeRows, viewRows, schema] = await Promise.all([
    db
      .select()
      .from(scopesTable)
      .orderBy(asc(scopesTable.sortOrder), asc(scopesTable.key)),
    db
      .select({
        viewName: scopeViews.viewName,
        scopeId: scopeViews.scopeId,
      })
      .from(scopeViews),
    readSchema(),
  ]);
  const schemaViews = schema.names;
  const viewMeta = schema.meta;

  // Count members referencing each scope key. Pull the raw dataScopes arrays
  // and tally in JS — at <500 members this is far simpler than wrestling the
  // JSONB unnest through drizzle's type system, and member-count is just for
  // a "you can't delete me" hint anyway.
  const activeMembers = await db
    .select({ dataScopes: members.dataScopes })
    .from(members)
    .where(ne(members.role, "revoked"));
  const memberCountByKey = new Map<string, number>();
  for (const r of activeMembers) {
    if (!Array.isArray(r.dataScopes)) continue;
    for (const k of r.dataScopes) {
      if (typeof k !== "string") continue;
      memberCountByKey.set(k, (memberCountByKey.get(k) ?? 0) + 1);
    }
  }

  const viewsByScopeId = new Map<number, string[]>();
  for (const r of viewRows) {
    const arr = viewsByScopeId.get(r.scopeId) ?? [];
    arr.push(r.viewName);
    viewsByScopeId.set(r.scopeId, arr);
  }

  const scopes: ScopeRow[] = scopeRows.map((s) => ({
    id: s.id,
    key: s.key,
    label: s.label,
    description: s.description,
    defaultForUser: s.defaultForUser,
    sortOrder: s.sortOrder,
    viewCount: viewsByScopeId.get(s.id)?.length ?? 0,
    memberCount: memberCountByKey.get(s.key) ?? 0,
  }));

  const assignments: Record<string, string[]> = {};
  for (const s of scopes) {
    assignments[s.key] = (viewsByScopeId.get(s.id) ?? []).slice().sort();
  }

  const mapped = new Set(viewRows.map((r) => r.viewName));
  const unassignedViews = schemaViews.filter((v) => !mapped.has(v));

  return { scopes, assignments, unassignedViews, viewMeta };
}
