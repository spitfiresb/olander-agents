"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { setTrialConfig } from "@/lib/trial";

// Server actions behind /admin/trial. Each re-checks the admin role server-side
// — the UI controls are a courtesy, not the gate. Part of the TEMPORARY trial
// feature (see schema.ts `trialBudget`); delete with the rest when retired.

async function requireAdmin() {
  const session = await auth();
  if (session?.user?.role !== "admin") {
    throw new Error("Forbidden — admin only.");
  }
  return session.user;
}

function actorOf(me: { email?: string | null; id?: string | null }): string | null {
  return me.email ?? me.id ?? null;
}

// Accepts a dollar amount (e.g. 10 or 25.50), stored as integer cents. Capped
// at $100k as a sanity bound against fat-finger entry.
const dollarsSchema = z.coerce.number().min(0).max(100_000);

export async function setTrialLimitAction(formData: FormData): Promise<void> {
  const me = await requireAdmin();
  const dollars = dollarsSchema.parse(formData.get("limitUsd"));
  await setTrialConfig({ limitCents: Math.round(dollars * 100) }, actorOf(me));
  revalidatePath("/admin/trial");
  revalidatePath("/chat");
}

export async function setTrialEnabledAction(enabled: boolean): Promise<void> {
  const me = await requireAdmin();
  await setTrialConfig({ enabled: z.boolean().parse(enabled) }, actorOf(me));
  revalidatePath("/admin/trial");
  revalidatePath("/chat");
}
