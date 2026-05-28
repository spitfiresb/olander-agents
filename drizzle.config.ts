import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";

config({ path: ".env.local" });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // Prefer the direct/unpooled connection for migrations. PgBouncer-pooled
    // URLs reject DDL like CREATE INDEX / GENERATED ALWAYS AS with prepared-
    // statement errors (docs/db.md). Falls back to the pooled URL for repos
    // where only DATABASE_URL is set.
    url: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!,
  },
});
