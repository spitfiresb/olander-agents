import { eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { members, sessions, users, type Role } from "@/db/schema";
import { normalizeEmail, parseBootstrapAdmins } from "@/lib/auth-allowlist";

// Sign-in allowlist + member-tier management. The `member` table is the source
// of truth for who may sign in and what tier they get; `user.role` (read by the
// rest of the app) is reconciled from it on every login (see events.signIn in
// src/auth.ts). Mirrors src/lib/conversations.ts: plain async functions, the
// `neon-http` driver has no transactions so statements run sequentially and
// partial failure is tolerated. Every entry point normalizes the email.

export type ActiveMember = {
  email: string;
  name: string | null;
  role: "user" | "admin";
};

// Always-allowed / always-admin emails from the environment, independent of the
// `member` table — first-admin bootstrap + break-glass if the table gets into a
// bad state. The Entra `tid` check still applies to these. Usually empty in
// practice once the seeded admins exist.
export function getBootstrapAdmins(): string[] {
  return parseBootstrapAdmins(process.env.AUTH_BOOTSTRAP_ADMINS);
}

// The sign-in gate's email half (the `tid` half lives in src/lib/auth-allowlist
// .ts). `allowed` is false for `revoked` members and for emails with no row.
export async function isAllowedMember(
  email: string,
): Promise<{ allowed: boolean; role: Role }> {
  const e = normalizeEmail(email);
  if (!e) return { allowed: false, role: "user" };
  if (getBootstrapAdmins().includes(e)) return { allowed: true, role: "admin" };
  const [row] = await db
    .select({ role: members.role })
    .from(members)
    .where(eq(members.email, e));
  if (!row) return { allowed: false, role: "user" };
  if (row.role === "revoked") return { allowed: false, role: "revoked" };
  return { allowed: true, role: row.role };
}

// Members shown in /admin/members: everyone except the `revoked` ones (those
// are hidden — re-add by email to restore them). Sorted with named members
// first (alphabetical by name), then email-only rows (alphabetical by email).
export async function listMembers(): Promise<ActiveMember[]> {
  const rows = await db
    .select({ email: members.email, role: members.role, name: users.name })
    .from(members)
    .leftJoin(users, sql`lower(${users.email}) = ${members.email}`)
    .where(ne(members.role, "revoked"))
    .orderBy(sql`(${users.name} is null), lower(${users.name}), ${members.email}`);
  return rows.map((r) => ({
    email: r.email,
    name: r.name,
    role: r.role === "admin" ? "admin" : "user",
  }));
}

export async function addMember(
  email: string,
  role: "user" | "admin",
  addedByUserId: string | null,
): Promise<void> {
  const e = normalizeEmail(email);
  if (!e) throw new Error("invalid_email");
  // `createdAt` intentionally not in the conflict `set` — re-adding (incl.
  // re-inviting a previously revoked email) keeps the original add-time and
  // just updates the tier and who touched it.
  await db
    .insert(members)
    .values({ email: e, role, addedBy: addedByUserId })
    .onConflictDoUpdate({
      target: members.email,
      set: { role, addedBy: addedByUserId },
    });
  await syncUserRole(e, role);
}

export async function setMemberRole(email: string, role: Role): Promise<void> {
  const e = normalizeEmail(email);
  if (!e) throw new Error("invalid_email");
  await db.update(members).set({ role }).where(eq(members.email, e));
  await syncUserRole(e, role);
}

// Reflect a tier onto the matching `user` row (no-op if they've never signed
// in). For `revoked`, also delete their active sessions so the change is
// immediate — they're logged out now and the signIn gate blocks re-login.
async function syncUserRole(
  normalizedEmail: string,
  role: Role,
): Promise<void> {
  await db
    .update(users)
    .set({ role })
    .where(sql`lower(${users.email}) = ${normalizedEmail}`);
  if (role === "revoked") {
    const userRows = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${normalizedEmail}`);
    if (userRows.length > 0) {
      await db.delete(sessions).where(
        inArray(
          sessions.userId,
          userRows.map((u) => u.id),
        ),
      );
    }
  }
}
