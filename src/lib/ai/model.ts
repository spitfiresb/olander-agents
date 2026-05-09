import { anthropic } from "@ai-sdk/anthropic";

const DEFAULT_MODEL_ID = "claude-sonnet-4-6";

export function getModel() {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  const modelId = process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL_ID;
  return anthropic(modelId);
}
