"use server";

import { revalidatePath } from "next/cache";
import { eq, inArray, max, sql } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/db";
import {
  members,
  scopeEntities,
  scopeViews,
  scopes as scopesTable,
} from "@/db/schema";
import {
  DEFAULT_ENTITY_SCOPES,
  DEFAULT_SCOPES,
  DEFAULT_VIEW_SCOPES,
} from "@/lib/scope-defaults";
import { invalidateScopeCatalog } from "@/lib/scopes";

// Server actions behind /admin/scopes. Every one re-checks the admin role
// server-side; thrown errors surface in the client as inline error text.
//
// Catalog rows are stored as data, not code — these actions mutate them.
// /api/chat/route.ts reloads the catalog on every request, so changes here
// take effect on the next chat turn without a server restart.

async function requireAdmin() {
  const session = await auth();
  if (session?.user?.role !== "admin") {
    throw new Error("Forbidden — admin only.");
  }
  return session.user;
}

function revalidate() {
  // Drop the per-process catalog cache so the next chat request sees the new
  // assignments without waiting for the TTL. Other Vercel instances refresh
  // on their next TTL expiry — acceptable since the catalog is read-mostly.
  invalidateScopeCatalog();
  revalidatePath("/admin/scopes");
  revalidatePath("/admin/members");
}

const keySchema = z
  .string()
  .min(1, "Key required.")
  .max(48, "Key too long.")
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "Key must be lowercase letters/digits/underscores (start with a letter).",
  );
const labelSchema = z.string().min(1, "Label required.").max(64);
const descriptionSchema = z.string().max(512);

// --- Scope CRUD ------------------------------------------------------------

export async function createScopeAction(input: {
  key: string;
  label: string;
  description?: string;
  defaultForUser: boolean;
}): Promise<void> {
  await requireAdmin();
  const parsed = z
    .object({
      key: keySchema,
      label: labelSchema,
      description: descriptionSchema.optional(),
      defaultForUser: z.boolean(),
    })
    .parse(input);

  // Pick a sortOrder above the current max so the new bucket lands at the
  // bottom of the list. Trying to slot it among existing rows is a UI choice
  // we'll defer until someone asks for it.
  const [{ value: maxOrder }] = await db
    .select({ value: max(scopesTable.sortOrder) })
    .from(scopesTable);
  await db.insert(scopesTable).values({
    key: parsed.key,
    label: parsed.label,
    description: parsed.description ?? "",
    defaultForUser: parsed.defaultForUser,
    sortOrder: (maxOrder ?? 0) + 10,
  });
  revalidate();
}

export async function updateScopeAction(
  scopeId: number,
  fields: {
    label?: string;
    description?: string;
    defaultForUser?: boolean;
  },
): Promise<void> {
  await requireAdmin();
  const parsed = z
    .object({
      label: labelSchema.optional(),
      description: descriptionSchema.optional(),
      defaultForUser: z.boolean().optional(),
    })
    .parse(fields);
  if (Object.keys(parsed).length === 0) return;
  await db
    .update(scopesTable)
    .set(parsed)
    .where(eq(scopesTable.id, scopeId));
  revalidate();
}

// Delete a scope. Blocks if any member still has the key in their
// dataScopes override — admin must clear it from those members first.
export async function deleteScopeAction(scopeId: number): Promise<void> {
  await requireAdmin();
  const [scope] = await db
    .select({ id: scopesTable.id, key: scopesTable.key })
    .from(scopesTable)
    .where(eq(scopesTable.id, scopeId));
  if (!scope) throw new Error("Scope not found.");

  const referencingMembers = await db
    .select({ email: members.email })
    .from(members)
    .where(sql`${members.dataScopes} @> ${JSON.stringify([scope.key])}::jsonb`);
  if (referencingMembers.length > 0) {
    const names = referencingMembers
      .slice(0, 3)
      .map((m) => m.email)
      .join(", ");
    const extra =
      referencingMembers.length > 3
        ? ` and ${referencingMembers.length - 3} more`
        : "";
    throw new Error(
      `Can't delete — ${names}${extra} still have this bucket assigned. Clear it from their data access first.`,
    );
  }

  // FK is ON DELETE CASCADE so scope_view / scope_entity rows pointing here
  // vanish automatically; those views become unassigned (deny-by-default).
  await db.delete(scopesTable).where(eq(scopesTable.id, scopeId));
  revalidate();
}

// --- View → scope assignment ----------------------------------------------

const viewNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9_]+$/i, "view names are alphanumeric + underscore");

// Move a batch of views to `toScopeKey`, or unassign them if `toScopeKey` is
// null. Idempotent — moving a view that's already in the target scope is a
// no-op; unassigning a view that isn't mapped is a no-op.
export async function moveViewsAction(
  viewNames: string[],
  toScopeKey: string | null,
): Promise<void> {
  await requireAdmin();
  const names = z.array(viewNameSchema).min(1).max(200).parse(viewNames);

  if (toScopeKey === null) {
    await db.delete(scopeViews).where(inArray(scopeViews.viewName, names));
    revalidate();
    return;
  }

  const [target] = await db
    .select({ id: scopesTable.id })
    .from(scopesTable)
    .where(eq(scopesTable.key, toScopeKey));
  if (!target) throw new Error(`Target scope "${toScopeKey}" not found.`);

  // Upsert each view to the target scope. PK is viewName, so ON CONFLICT
  // overwrites the previous scopeId — exactly what "move" means.
  for (const v of names) {
    await db
      .insert(scopeViews)
      .values({ viewName: v, scopeId: target.id })
      .onConflictDoUpdate({
        target: scopeViews.viewName,
        set: { scopeId: target.id },
      });
  }
  revalidate();
}

// --- Reset to defaults -----------------------------------------------------

// Wipe scope_view / scope_entity / scope and re-seed from
// src/lib/scope-defaults.ts. Member dataScopes overrides are NOT cleared —
// any keys that don't survive the reset will be silently dropped by
// sanitizeScopes on next read.
export async function resetToDefaultsAction(): Promise<void> {
  await requireAdmin();

  // The neon-http driver has no real transactions; do this in dependency
  // order (assignments first, then scopes) so a partial failure leaves a
  // consistent state — admin can hit Reset again to finish.
  await db.delete(scopeViews);
  await db.delete(scopeEntities);
  await db.delete(scopesTable);

  await db
    .insert(scopesTable)
    .values(
      DEFAULT_SCOPES.map((s) => ({
        key: s.key,
        label: s.label,
        description: s.description,
        defaultForUser: s.defaultForUser,
        sortOrder: s.sortOrder,
      })),
    );

  const rows = await db
    .select({ id: scopesTable.id, key: scopesTable.key })
    .from(scopesTable);
  const idByKey = new Map(rows.map((r) => [r.key, r.id]));

  await db.insert(scopeViews).values(
    DEFAULT_VIEW_SCOPES.map(([viewName, scopeKey]) => ({
      viewName,
      scopeId: idByKey.get(scopeKey)!,
    })),
  );

  await db.insert(scopeEntities).values(
    DEFAULT_ENTITY_SCOPES.map((e) => ({
      area: e.area,
      resource: e.resource,
      scopeId: idByKey.get(e.scopeKey)!,
    })),
  );

  // member.dataScopes overrides aren't touched — keys that survive the reset
  // keep working; keys that don't are dropped by sanitizeScopes on next read.
  // Same for the user.dataScopes mirror — heals automatically per-request.

  revalidate();
}
