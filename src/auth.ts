import NextAuth from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/db";
import { users, accounts, sessions, verificationTokens } from "@/db/schema";

// uoregon.edu is for the dev/test phase. Drop it before handing off to Olander.
const ALLOWED_DOMAINS = ["olander.com", "uoregon.edu"];

// Entra `tid` is bound to Microsoft's per-tenant signing key; `email` is not
// (a tenant admin can set the directory `mail` attribute to any string, so a
// foreign tenant could mint a valid token claiming `email: x@olander.com`).
// Look up GUIDs at:
//   https://login.microsoftonline.com/<domain>/.well-known/openid-configuration
const ALLOWED_TENANT_IDS = (process.env.AUTH_ALLOWED_TENANT_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedDomain(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.toLowerCase();
  return ALLOWED_DOMAINS.some((d) => normalized.endsWith("@" + d));
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  providers: [
    MicrosoftEntraID({
      // Force the Microsoft account picker every time. Without this, Microsoft
      // SSO silently returns whichever account the browser is already signed
      // into — which often isn't the right tenant — and the user lands on
      // Auth.js's "Access Denied" page with no way to switch accounts.
      authorization: {
        params: { scope: "openid profile email User.Read", prompt: "select_account" },
      },
    }),
  ],
  session: { strategy: "database" },
  pages: { error: "/auth/error" },
  callbacks: {
    signIn({ profile }) {
      // Fail closed if the operator hasn't populated AUTH_ALLOWED_TENANT_IDS.
      if (ALLOWED_TENANT_IDS.length === 0) return false;
      const tid = typeof profile?.tid === "string" ? profile.tid : null;
      if (!tid || !ALLOWED_TENANT_IDS.includes(tid)) return false;
      const email = typeof profile?.email === "string" ? profile.email : null;
      return isAllowedDomain(email);
    },
    session({ session, user }) {
      session.user.role = user.role;
      return session;
    },
  },
});
