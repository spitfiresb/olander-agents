import NextAuth from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/db";
import { users, accounts, sessions, verificationTokens } from "@/db/schema";

const ALLOWED_DOMAINS = ["olander.com", "uoregon.edu"];
const ALLOWED_EMAILS = ["olanderagents@gmail.com"];

function isAllowed(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.toLowerCase();
  if (ALLOWED_EMAILS.includes(normalized)) return true;
  return ALLOWED_DOMAINS.some((d) => normalized.endsWith("@" + d));
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  providers: [MicrosoftEntraID],
  session: { strategy: "database" },
  callbacks: {
    signIn({ user }) {
      return isAllowed(user.email);
    },
    session({ session, user }) {
      session.user.role = user.role;
      return session;
    },
  },
});
