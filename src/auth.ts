import NextAuth from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/db";
import { users, accounts, sessions, verificationTokens } from "@/db/schema";
import { evaluateSignIn } from "@/lib/auth-allowlist";

// Entra `tid` is bound to Microsoft's per-tenant signing key; `email` is not
// (a tenant admin can set the directory `mail` attribute to any string, so a
// foreign tenant could mint a valid token claiming `email: x@olander.com`).
// Look up GUIDs at:
//   https://login.microsoftonline.com/<domain>/.well-known/openid-configuration
const ALLOWED_TENANT_IDS = (process.env.AUTH_ALLOWED_TENANT_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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
      return evaluateSignIn(profile, {
        allowedTenantIds: ALLOWED_TENANT_IDS,
      });
    },
    session({ session, user }) {
      session.user.id = user.id;
      session.user.role = user.role;
      return session;
    },
  },
});
