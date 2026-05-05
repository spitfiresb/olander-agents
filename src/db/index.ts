import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

// Fallback so module load (Next.js build-time data collection, type checks)
// doesn't require DATABASE_URL. Connection only happens on first query;
// requests will fail loudly if the env var is still missing at that point.
const url = process.env.DATABASE_URL ?? "postgres://placeholder@build/db";

export const db = drizzle(neon(url), { schema });
