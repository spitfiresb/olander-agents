import type { DefaultSession } from "next-auth";
import type { Role } from "@/db/schema";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: Role;
      // null = "use the tier default" (resolved against src/lib/scopes.ts at
      // call time). Admins bypass scope checks entirely regardless of value.
      dataScopes: string[] | null;
    } & DefaultSession["user"];
  }

  interface User {
    role: Role;
    dataScopes: string[] | null;
  }
}
