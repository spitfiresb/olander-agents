import { eq } from "drizzle-orm";
import { db } from "@/db";
import { uploadSettings } from "@/db/schema";
import { MAX_UPLOAD_CEILING_BYTES } from "@/lib/blob";

// Admin-configurable max upload size. The value is stored as whole megabytes in
// the `upload_settings` singleton (src/db/schema.ts) and edited at
// /admin/uploads. Everything that gates an upload — the uploads route, the chat
// body schema's ceiling, and the chat composer's client-side pre-check — routes
// through getMaxUploadBytes(). Fail-open to the default on any DB error so a
// hiccup raises the cap to the default rather than blocking all uploads.

const SINGLETON_ID = "singleton";
const MB = 1024 * 1024;

export const DEFAULT_MAX_UPLOAD_MB = 25;
export const MIN_MAX_UPLOAD_MB = 1;
// Hard ceiling, derived from the absolute byte ceiling in blob.ts so the two
// can't drift. Admins cannot set a value above this.
export const MAX_MAX_UPLOAD_MB = Math.floor(MAX_UPLOAD_CEILING_BYTES / MB);

// Clamp to [MIN, MAX] and coerce to a whole number. NaN/Infinity fall back to
// the default rather than the bounds so a garbage input doesn't silently set
// the cap to its extreme.
export function clampMaxUploadMb(mb: number): number {
  if (!Number.isFinite(mb)) return DEFAULT_MAX_UPLOAD_MB;
  const whole = Math.floor(mb);
  if (whole < MIN_MAX_UPLOAD_MB) return MIN_MAX_UPLOAD_MB;
  if (whole > MAX_MAX_UPLOAD_MB) return MAX_MAX_UPLOAD_MB;
  return whole;
}

export async function getMaxUploadMb(): Promise<number> {
  try {
    const rows = await db
      .select({ maxFileMb: uploadSettings.maxFileMb })
      .from(uploadSettings)
      .where(eq(uploadSettings.id, SINGLETON_ID))
      .limit(1);
    const row = rows[0];
    if (!row) return DEFAULT_MAX_UPLOAD_MB;
    // Clamp on read too: a value written directly to the DB outside the app
    // can't push the effective limit past the ceiling.
    return clampMaxUploadMb(row.maxFileMb);
  } catch (err) {
    console.error("[upload-settings] read failed (failing open to default):", err);
    return DEFAULT_MAX_UPLOAD_MB;
  }
}

export async function getMaxUploadBytes(): Promise<number> {
  return (await getMaxUploadMb()) * MB;
}

// Upsert the singleton row. Creating it on first save means no migration seed
// is required for the control to work.
export async function setMaxUploadMb(mb: number, updatedBy: string | null): Promise<number> {
  const value = clampMaxUploadMb(mb);
  await db
    .insert(uploadSettings)
    .values({ id: SINGLETON_ID, maxFileMb: value, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: uploadSettings.id,
      set: { maxFileMb: value, updatedBy, updatedAt: new Date() },
    });
  return value;
}
