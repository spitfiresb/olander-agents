// Same-origin gate for state-changing API routes. Belt to Auth.js v5's
// SameSite=Lax cookie suspenders — Lax already blocks cross-site POSTs from
// carrying our session cookie, but checking Origin / Referer makes the
// intent legible and survives a future cookie-attribute regression.
//
// Same-origin: source's host (Origin first, then Referer) matches the
// request's Host header.
// Missing Origin AND Referer: allow (browsers omit Origin on some
// same-origin POSTs; server-to-server calls don't send either; auth()
// remains the real gate either way).
export function isSameOrigin(headers: Headers): boolean {
  const host = headers.get("host");
  if (!host) return false;
  const source = headers.get("origin") ?? headers.get("referer");
  if (!source) return true;
  try {
    return new URL(source).host === host;
  } catch {
    return false;
  }
}
