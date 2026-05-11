import { anthropic, createAnthropic } from "@ai-sdk/anthropic";

const DEFAULT_MODEL_ID = "claude-sonnet-4-6";

// Factual lookups, not creative writing — low temperature keeps answers terse
// and reduces drift. Bumping above 0.4 has historically introduced "let me
// make sure I have this right…" filler that reps don't need.
export const MODEL_TEMPERATURE = 0.2;

// Bounds long-tail latency. Any factual lookup answer should fit comfortably;
// if a real question truncates, raise here rather than letting the long tail
// blow past the 60s edge function timeout.
export const MODEL_MAX_OUTPUT_TOKENS = 2048;

// Set to "1" in dev to log the JSON body of every Anthropic request. Useful
// for verifying prompt-cache markers actually reach the API. Never enable in
// production — bodies contain the entire chat history.
const DEBUG_ANTHROPIC_REQ = process.env.DEBUG_ANTHROPIC_REQ === "1";

function loggingFetch(input: RequestInfo | URL, init?: RequestInit) {
  if (!DEBUG_ANTHROPIC_REQ) return fetch(input, init);
  try {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let bodyPreview: unknown = null;
    if (typeof init?.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as Record<string, unknown>;
        const systemBlocks = Array.isArray(parsed.system)
          ? (parsed.system as Array<Record<string, unknown>>).map((b) => ({
              type: b.type,
              cache_control: b.cache_control ?? null,
              text_chars: typeof b.text === "string" ? b.text.length : null,
            }))
          : typeof parsed.system;
        const toolsCache = Array.isArray(parsed.tools)
          ? (parsed.tools as Array<Record<string, unknown>>).map((t) => ({
              name: t.name,
              cache_control: t.cache_control ?? null,
            }))
          : 0;
        bodyPreview = {
          model: parsed.model,
          systemBlocks,
          toolsCache,
          messageCount: Array.isArray(parsed.messages)
            ? (parsed.messages as unknown[]).length
            : 0,
        };
      } catch {
        bodyPreview = init.body.slice(0, 200);
      }
    }
    console.log("[anthropic-req]", JSON.stringify({ url, body: bodyPreview }));
  } catch (err) {
    console.warn("[anthropic-req] logger failed", err);
  }
  return fetch(input, init);
}

export function getModel() {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  const modelId = process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL_ID;
  if (DEBUG_ANTHROPIC_REQ) {
    return createAnthropic({ apiKey, fetch: loggingFetch })(modelId);
  }
  return anthropic(modelId);
}
