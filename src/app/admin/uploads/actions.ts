"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { clampMaxUploadMb, setMaxUploadMb } from "@/lib/upload-settings";

// Server action behind /admin/uploads. Re-checks the admin role server-side;
// thrown errors surface as inline text in the form. The chat route and uploads
// route read the value fresh per request, so a change here takes effect on the
// next upload without a restart.

async function requireAdmin() {
  const session = await auth();
  if (session?.user?.role !== "admin") {
    throw new Error("Forbidden — admin only.");
  }
  return session.user;
}

// Save the new per-file limit (whole MB). The value is clamped to the allowed
// bounds server-side regardless of what the client sent; the clamped result is
// returned so the form can show what was actually stored.
export async function setMaxUploadMbAction(mb: number): Promise<number> {
  const admin = await requireAdmin();
  if (!Number.isFinite(mb)) {
    throw new Error("Enter a whole number of megabytes.");
  }
  const saved = await setMaxUploadMb(clampMaxUploadMb(mb), admin.id ?? admin.email ?? null);
  revalidatePath("/admin/uploads");
  return saved;
}
