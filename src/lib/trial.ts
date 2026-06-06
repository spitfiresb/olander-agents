import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { messages, trialBudget } from "@/db/schema";
import { estimateUsd } from "@/lib/ai/pricing";

// TEMPORARY trial spend gate (see schema.ts `trialBudget`). Deployment-wide,
// not per-user: one $10 allowance for the whole handoff. Everything the gate
// needs lives in this file + the trialBudget table so it's easy to delete when
// the client moves to real billing.

const SINGLETON_ID = "singleton";

export type TrialConfig = {
  enabled: boolean;
  limitCents: number;
  updatedAt: Date | null;
  updatedBy: string | null;
};

export type TrialStatus = TrialConfig & {
  spentUsd: number;
  limitUsd: number;
  remainingUsd: number;
  exhausted: boolean;
};

const DEFAULTS: TrialConfig = {
  enabled: true,
  limitCents: 1000,
  updatedAt: null,
  updatedBy: null,
};

// Read the singleton config row. The migration seeds it, but fall back to
// DEFAULTS if it's somehow missing so the gate never crashes the chat route.
export async function getTrialConfig(): Promise<TrialConfig> {
  const rows = await db.select().from(trialBudget).where(eq(trialBudget.id, SINGLETON_ID)).limit(1);
  const row = rows[0];
  if (!row) return DEFAULTS;
  return {
    enabled: row.enabled,
    limitCents: row.limitCents,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

// Total estimated USD spend across ALL assistant turns, priced per-model so a
// mixed Sonnet/GPT-5 history is costed correctly. Aggregates in Postgres and
// prices the per-model buckets in JS (the price table lives in pricing.ts).
export async function totalSpendUsd(): Promise<number> {
  const rows = await db
    .select({
      model: messages.model,
      inputTokens: sql<number>`coalesce(sum((${messages.usage}->>'inputTokens')::int), 0)`.mapWith(
        Number,
      ),
      cachedInputTokens:
        sql<number>`coalesce(sum((${messages.usage}->>'cachedInputTokens')::int), 0)`.mapWith(
          Number,
        ),
      outputTokens: sql<number>`coalesce(sum((${messages.usage}->>'outputTokens')::int), 0)`.mapWith(
        Number,
      ),
    })
    .from(messages)
    .where(eq(messages.role, "assistant"))
    .groupBy(messages.model);

  return rows.reduce((sum, r) => sum + estimateUsd(r.model, r), 0);
}

export async function getTrialStatus(): Promise<TrialStatus> {
  const [config, spentUsd] = await Promise.all([getTrialConfig(), totalSpendUsd()]);
  const limitUsd = config.limitCents / 100;
  return {
    ...config,
    spentUsd,
    limitUsd,
    remainingUsd: Math.max(0, limitUsd - spentUsd),
    // Only blocks when the gate is on. Disabling it is the kill switch.
    exhausted: config.enabled && spentUsd >= limitUsd,
  };
}

// Trimmed, client-safe slice for the chat UI banner (no admin-only fields).
// Shape matches TrialBannerData in src/app/chat/TrialBanner.tsx. Fail-open: any
// error (e.g. the migration not yet applied) returns a disabled state so the
// chat page renders normally rather than 500-ing — same stance as the route's
// gate check. The route enforces the hard-stop; this only drives the banner.
export async function getTrialBannerData() {
  try {
    const s = await getTrialStatus();
    return {
      enabled: s.enabled,
      exhausted: s.exhausted,
      spentUsd: s.spentUsd,
      limitUsd: s.limitUsd,
      remainingUsd: s.remainingUsd,
    };
  } catch (err) {
    console.error("[trial] banner status failed (disabling banner):", err);
    return { enabled: false, exhausted: false, spentUsd: 0, limitUsd: 0, remainingUsd: 0 };
  }
}

// No write path: the trial budget is provisioned out-of-band (the migration
// seeds the singleton row) and the app only ever reads it. There is
// deliberately no admin control to raise the limit or disable the gate.
