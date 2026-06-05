import NextAuth from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, accounts, sessions, verificationTokens } from "@/db/schema";
import { evaluateTenant } from "@/lib/auth-allowlist";
import { isAllowedMember } from "@/lib/members";

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
      // Request only the OIDC sign-in scopes — no Microsoft Graph permissions.
      // We only ever read the ID-token claims (`tid` for the tenant gate below,
      // plus `email`), so `User.Read` bought us nothing but a profile photo —
      // and it's a Graph *resource* permission, which is what triggers the
      // "Need admin approval" gate for non-admin users in tenants that restrict
      // consent to verified-publisher apps. Pure OIDC sign-in is user-
      // consentable in those tenants. Dropping User.Read makes the provider's
      // profile() photo fetch 403, so `image` falls back to null; sign-in is
      // unaffected.
      //
      // `prompt: select_account` forces the Microsoft account picker every time.
      // Without it, SSO silently returns whichever account the browser is
      // already signed into — often the wrong tenant — and the user lands on
      // Auth.js's "Access Denied" page with no way to switch accounts.
      authorization: {
        params: { scope: "openid profile email", prompt: "select_account" },
      },
    }),
  ],
  session: { strategy: "database" },
  pages: { error: "/auth/error" },
  callbacks: {
    // Two gates, both must pass: the Entra `tid` claim (cryptographic boundary,
    // src/lib/auth-allowlist.ts) and a non-`revoked` row in the `member` table
    // — or membership in AUTH_BOOTSTRAP_ADMINS (src/lib/members.ts). Returning
    // false sends the user to /auth/error.
    async signIn({ profile }) {
      const { ok, email } = evaluateTenant(profile, {
        allowedTenantIds: ALLOWED_TENANT_IDS,
      });
      if (!ok || !email) {
        const p = profile as { tid?: unknown; email?: unknown } | null | undefined;
        console.warn("[auth] sign-in denied at the tenant/email gate", {
          tid: typeof p?.tid === "string" ? p.tid : `(${typeof p?.tid})`,
          emailPresent: typeof p?.email === "string",
          allowedTenantCount: ALLOWED_TENANT_IDS.length,
          // If allowedTenantCount is 0, set AUTH_ALLOWED_TENANT_IDS in your env
          // to the `tid` shown above (comma-separated for multiple tenants).
        });
        return false;
      }
      let allowed = false;
      try {
        ({ allowed } = await isAllowedMember(email));
      } catch (err) {
        console.error("[auth] membership check threw for", email, "—", err);
        return false;
      }
      if (!allowed) {
        console.warn("[auth] sign-in denied: not an allowed member:", email);
      }
      return allowed;
    },
    session({ session, user }) {
      session.user.id = user.id;
      session.user.role = user.role;
      // `dataScopes` is null when the member row says "use the tier default".
      // Effective scopes are resolved against this at call time by
      // src/lib/scopes.ts; admins bypass the check entirely.
      session.user.dataScopes = (user as { dataScopes?: string[] | null })
        .dataScopes ?? null;
      return session;
    },
  },
  events: {
    // Reconcile `user.role` from the `member` table on every login. The adapter
    // creates new users with the schema default (`user`), so this is what
    // actually applies an `admin` tier to someone an admin invited before they
    // first signed in — and it self-heals after any later tier change. Runs
    // after createUser/linkAccount/createSession, so `user` is the persisted
    // row; only writes when the value differs.
    async signIn({ user }) {
      if (!user?.email || !user.id) return;
      const { allowed, role, dataScopes } = await isAllowedMember(user.email);
      if (!allowed) return;
      const currentScopes =
        (user as { dataScopes?: string[] | null }).dataScopes ?? null;
      const roleChanged = user.role !== role;
      const scopesChanged =
        JSON.stringify(currentScopes ?? null) !==
        JSON.stringify(dataScopes ?? null);
      if (roleChanged || scopesChanged) {
        await db
          .update(users)
          .set({ role, dataScopes })
          .where(eq(users.id, user.id));
      }
    },
  },
});

// `auth()`, but a `revoked` member is treated as having no session — so any
// route that gates on `session?.user` denies them automatically. Their sessions
// are also deleted at revoke time (src/lib/members.ts); this is the belt to
// that braces, covering the race window and any code path that forgets the
// role check. Use this anywhere a signed-in *active* user is required.
export async function activeSession() {
  const session = await auth();
  if (session?.user?.role === "revoked") return null;
  return session;
}
