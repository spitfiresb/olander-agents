// DEV ONLY. Mints a session for a synthetic user (creates the user if it
// doesn't already exist) and returns it as a Set-Cookie. Hard-gated on
// NODE_ENV=development AND ALLOW_UNAUTHED_DEV=1 — the route 404s otherwise.
//
// Used by verification scripts and by humans walking auth-gated pages
// without going through the full Microsoft Entra flow. NEVER ship this in
// production: it bypasses the tenant + domain allowlist entirely.

import crypto from "node:crypto";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, sessions } from "@/db/schema";

export const dynamic = "force-dynamic";

function devEnabled() {
  return (
    process.env.NODE_ENV === "development" &&
    process.env.VERCEL_ENV !== "production" &&
    process.env.ALLOW_UNAUTHED_DEV === "1"
  );
}

export async function POST(req: Request) {
  if (!devEnabled()) {
    notFound();
  }
  const url = new URL(req.url);
  const email = url.searchParams.get("email") ?? "dev-admin@local.test";
  const role = url.searchParams.get("role") === "admin" ? "admin" : "user";

  const existing = await db.select().from(users).where(eq(users.email, email));
  let user = existing[0];
  if (!user) {
    [user] = await db
      .insert(users)
      .values({ name: `Dev ${role}`, email, role })
      .returning();
  } else if (user.role !== role) {
    [user] = await db
      .update(users)
      .set({ role })
      .where(eq(users.id, user.id))
      .returning();
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({
    sessionToken: token,
    userId: user.id,
    expires,
  });

  // Auth.js v5 cookie name: `authjs.session-token` (insecure, dev).
  // In production this route is unreachable, so we never need the
  // `__Secure-` prefix.
  const cookie = [
    `authjs.session-token=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${24 * 60 * 60}`,
  ].join("; ");

  return Response.json(
    { user, sessionToken: token, expires: expires.toISOString() },
    { headers: { "Set-Cookie": cookie } },
  );
}
