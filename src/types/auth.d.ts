import type { DefaultSession } from "next-auth";
import type { Role } from "@/db/schema";

declare module "next-auth" {
  interface Session {
    user: {
      role: Role;
    } & DefaultSession["user"];
  }

  interface User {
    role: Role;
  }
}
