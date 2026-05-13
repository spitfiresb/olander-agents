// Pure sign-in primitives used by both the live NextAuth signIn callback
// (src/auth.ts) and the unit tests. Kept free of `next`, `next-auth`, and
// `@/db` imports so the tests can exercise the logic without booting the
// next-auth runtime or a database connection.
//
// The email allowlist itself lives in the `member` table and is read via
// src/lib/members.ts — this file only does the tenant check and email
// normalization, which are the parts worth unit-testing in isolation.

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Parse a comma-separated env value (AUTH_BOOTSTRAP_ADMINS) into a normalized
// email list. Empty / whitespace-only entries are dropped.
export function parseBootstrapAdmins(
  envValue: string | null | undefined,
): string[] {
  if (!envValue) return [];
  return envValue
    .split(",")
    .map((s) => normalizeEmail(s))
    .filter(Boolean);
}

// Tenant gate. Entra `tid` is bound to Microsoft's per-tenant signing key;
// `email` is not (a tenant admin can set the directory `mail` attribute to any
// string, so a foreign tenant could mint a valid token claiming
// `email: x@olander.com`). So the `tid` check is the cryptographic security
// boundary — it must pass before we even look at the email. An empty tenant
// allowlist fails closed.
//
// Note this does NOT decide whether the email is allowed — that's the `member`
// table lookup (src/lib/members.ts), called by src/auth.ts after this returns
// `{ ok: true }`. A non-Olander email like `x@example.com` returns
// `{ ok: true, email: "x@example.com" }` here; the membership check rejects it.
export function evaluateTenant(
  profile: { tid?: unknown; email?: unknown } | null | undefined,
  opts: { allowedTenantIds?: readonly string[] },
): { ok: boolean; email: string | null } {
  const fail = { ok: false, email: null } as const;
  const tenantIds = opts.allowedTenantIds ?? [];
  if (tenantIds.length === 0) return fail;
  const tid = typeof profile?.tid === "string" ? profile.tid : null;
  if (!tid || !tenantIds.includes(tid)) return fail;
  const email = typeof profile?.email === "string" ? profile.email : null;
  if (!email) return fail;
  const normalized = normalizeEmail(email);
  if (!normalized) return fail;
  return { ok: true, email: normalized };
}
