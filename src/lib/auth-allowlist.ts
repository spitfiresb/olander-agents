// Pure allowlist primitives used by both the live NextAuth signIn callback
// (src/auth.ts) and the unit tests. Kept free of `next` and `next-auth`
// imports so the tests can exercise the logic without booting the entire
// next-auth runtime.

export const ALLOWED_DOMAINS = ["olander.com"];

export function isAllowedDomain(
  email: string | null | undefined,
  allowed: readonly string[] = ALLOWED_DOMAINS,
): boolean {
  if (!email) return false;
  const normalized = email.toLowerCase();
  return allowed.some((d) => normalized.endsWith("@" + d));
}

// Tenant-first, then domain. Empty allowlist fails closed. The split between
// tid (cryptographically bound to a tenant signing key) and email (settable
// by a tenant admin) is the security boundary — both must pass.
export function evaluateSignIn(
  profile: { tid?: unknown; email?: unknown } | null | undefined,
  opts: {
    allowedTenantIds?: readonly string[];
    allowedDomains?: readonly string[];
  },
): boolean {
  const tenantIds = opts.allowedTenantIds ?? [];
  if (tenantIds.length === 0) return false;
  const tid = typeof profile?.tid === "string" ? profile.tid : null;
  if (!tid || !tenantIds.includes(tid)) return false;
  const email = typeof profile?.email === "string" ? profile.email : null;
  return isAllowedDomain(email, opts.allowedDomains);
}
