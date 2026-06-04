// Per-model USD pricing, used by the trial spend gate (src/lib/trial.ts) and
// the admin usage page. These are public list prices per 1M tokens at time of
// writing — INFORMATIONAL estimates only. They will drift from the provider's
// authoritative billing (especially around cached/reasoning tokens), which is
// fine: the trial gate just needs to trip *near* the limit, not to the penny.
//
// Token accounting notes:
//   - inputTokens is the TOTAL prompt tokens; cachedInputTokens is the cached
//     subset of it, billed cheaper. Fresh = inputTokens - cachedInputTokens.
//   - outputTokens already includes reasoning tokens for reasoning models, so
//     pricing on outputTokens covers GPT-5 reasoning spend without double-count.

export type ModelPricing = {
  inputPerM: number;
  cachedInputPerM: number;
  outputPerM: number;
};

// Keyed by the exact model id stored on message.model. Unknown ids fall back to
// DEFAULT_PRICING below (the current default model), so a future model still
// gets a reasonable estimate until it's added here.
const PRICING: Record<string, ModelPricing> = {
  // Anthropic — Claude Sonnet 4.6
  "claude-sonnet-4-6": { inputPerM: 3, cachedInputPerM: 0.3, outputPerM: 15 },
  // Anthropic — Claude Haiku 4.5 (cached input ≈ 10% of fresh)
  "claude-haiku-4-5": { inputPerM: 1, cachedInputPerM: 0.1, outputPerM: 5 },
  "claude-haiku-4-5-20251001": { inputPerM: 1, cachedInputPerM: 0.1, outputPerM: 5 },
  // OpenAI — GPT-5 mini (cached input ≈ 10% of fresh input)
  "gpt-5-mini": { inputPerM: 0.25, cachedInputPerM: 0.025, outputPerM: 2 },
  // OpenAI — GPT-4.1 mini (current default while gpt-5 verification is pending)
  "gpt-4.1-mini": { inputPerM: 0.4, cachedInputPerM: 0.1, outputPerM: 1.6 },
  // OpenAI — GPT-4o mini (non-gated smoke tests / fallback)
  "gpt-4o-mini": { inputPerM: 0.15, cachedInputPerM: 0.075, outputPerM: 0.6 },
};

// Fallback for unknown/null model ids — assume the cheaper current model so an
// unlabeled row doesn't wildly overstate spend.
const DEFAULT_PRICING: ModelPricing = PRICING["gpt-5-mini"];

export function pricingFor(model: string | null | undefined): ModelPricing {
  return (model && PRICING[model]) || DEFAULT_PRICING;
}

export function estimateUsd(
  model: string | null | undefined,
  tokens: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
): number {
  const p = pricingFor(model);
  const fresh = Math.max(0, tokens.inputTokens - tokens.cachedInputTokens);
  return (
    (fresh * p.inputPerM +
      tokens.cachedInputTokens * p.cachedInputPerM +
      tokens.outputTokens * p.outputPerM) /
    1_000_000
  );
}
