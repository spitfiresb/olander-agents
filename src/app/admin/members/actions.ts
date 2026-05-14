"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { normalizeEmail } from "@/lib/auth-allowlist";
import {
  addMember,
  listMembers,
  setMemberRole,
  setMemberScopes,
} from "@/lib/members";
import { ALL_SCOPES, type Scope } from "@/lib/scopes";

// Server actions behind /admin/members. Every one re-checks the admin role
// server-side — the disabled controls in the UI are a courtesy, not the gate.
// Thrown errors are caught and shown by the client; an uncaught one falls to
// the nearest error boundary, which is acceptable for an admin-only tool.

const emailSchema = z.string().email();
const tierSchema = z.enum(["user", "admin"]);

async function requireAdmin() {
  const session = await auth();
  if (session?.user?.role !== "admin") {
    throw new Error("Forbidden — admin only.");
  }
  return session.user;
}

function myNormalizedEmail(me: { email?: string | null }): string | null {
  return me.email ? normalizeEmail(me.email) : null;
}

// Add a new member, or re-add (re-invite) a previously removed/revoked one —
// `addMember` upserts, so a `revoked` email comes back at the chosen tier.
export async function addMemberAction(formData: FormData): Promise<void> {
  const me = await requireAdmin();
  const email = normalizeEmail(emailSchema.parse(formData.get("email")));
  const role = tierSchema.parse(formData.get("role") ?? "user");
  await addMember(email, role, me.id);
  revalidatePath("/admin/members");
}

// Apply a batch of tier changes (the "Save changes" button). Validates the net
// effect up front: refuses if it would leave zero admins, or demote yourself.
export async function setTiersAction(
  changes: { email: string; role: "user" | "admin" }[],
): Promise<void> {
  const me = await requireAdmin();
  const parsed = z
    .array(z.object({ email: emailSchema, role: tierSchema }))
    .parse(changes);
  const normalized = parsed.map((c) => ({
    email: normalizeEmail(c.email),
    role: c.role,
  }));
  if (normalized.length === 0) return;

  const mine = myNormalizedEmail(me);
  for (const c of normalized) {
    if (c.email === mine && c.role !== "admin") {
      throw new Error("You can't change your own tier.");
    }
  }

  // Simulate the resulting admin set against the current members.
  const current = await listMembers();
  const admins = new Set(
    current.filter((m) => m.role === "admin").map((m) => m.email),
  );
  for (const c of normalized) {
    if (c.role === "admin") admins.add(c.email);
    else admins.delete(c.email);
  }
  if (admins.size === 0) {
    throw new Error("That would leave no admins — keep at least one.");
  }

  for (const c of normalized) {
    await setMemberRole(c.email, c.role);
  }
  revalidatePath("/admin/members");
}

// Set the per-member data-scope override. `scopes === null` clears the
// override and falls back to the tier default; an empty array means "no
// scopes" (every P21 view/entity call is denied). Admins are a no-op — they
// bypass the scope check regardless — but we still write the row so the admin
// UI reflects the choice if the user is later demoted.
const scopeNameSchema = z.enum(ALL_SCOPES as [Scope, ...Scope[]]);

export async function setMemberScopesAction(
  email: string,
  scopes: Scope[] | null,
): Promise<void> {
  await requireAdmin();
  const e = normalizeEmail(emailSchema.parse(email));
  const cleaned =
    scopes === null
      ? null
      : z.array(scopeNameSchema).parse(scopes);
  await setMemberScopes(e, cleaned);
  revalidatePath("/admin/members");
}

// "Remove user" — sets the member to `revoked` (their session rows are deleted
// and they lose all access; their account + chat history are kept). Re-add by
// email to restore. Refuses to remove yourself or the last admin.
export async function removeMemberAction(email: string): Promise<void> {
  const me = await requireAdmin();
  const e = normalizeEmail(emailSchema.parse(email));
  if (myNormalizedEmail(me) === e) {
    throw new Error("You can't remove yourself.");
  }
  const current = await listMembers();
  const target = current.find((m) => m.email === e);
  if (
    target?.role === "admin" &&
    current.filter((m) => m.role === "admin" && m.email !== e).length === 0
  ) {
    throw new Error("That's the last admin — promote someone else first.");
  }
  await setMemberRole(e, "revoked");
  revalidatePath("/admin/members");
}
