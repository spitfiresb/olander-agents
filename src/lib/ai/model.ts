import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";

type Provider = "anthropic" | "openai";

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
// TEMPORARY: gpt-4.1-mini while the OpenAI org verification for the gpt-5 family
// is pending (gpt-5-mini requires a *verified* org; gpt-4.1-mini does not).
// gpt-4.1-mini over gpt-4o-mini because 4o-mini looped on multi-step tool calls
// (burned the step budget without answering); 4.1-mini is built for agentic
// tool use. Switch back to "gpt-5-mini" once verification clears. An
// OPENAI_MODEL env var overrides this either way.
const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

// Which provider the chat route talks to. Defaults to Anthropic so existing
// deployments are untouched; set AI_PROVIDER=openai (plus OPENAI_API_KEY) to
// run GPT-5 mini. The whole point of routing through here is to A/B a cheaper
// model behind a single env var with no code change.
function resolveProvider(): Provider {
  return process.env.AI_PROVIDER?.trim().toLowerCase() === "openai"
    ? "openai"
    : "anthropic";
}

// The active model id — used both to construct the model and to stamp the
// `model` column on persisted assistant messages so history stays accurate
// across a provider switch.
export function getModelId(): string {
  return resolveProvider() === "openai"
    ? process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL
    : process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL;
}

// Per-provider generation settings, spread into streamText so the route stays
// provider-agnostic.
//
// Anthropic: temperature 0.2 keeps answers terse and reduces drift. Bumping
// above 0.4 has historically introduced "let me make sure I have this right…"
// filler that reps don't need.
//
// OpenAI splits into two families with OPPOSITE requirements:
//   - GPT-5 (reasoning): REJECT an explicit temperature (only the default of 1
//     is allowed), so we omit it and get terseness from `textVerbosity: 'low'`;
//     `reasoningEffort: 'low'` buys enough chain-of-thought for reliable
//     multi-step tool selection without deep deliberation on straight lookups.
//   - gpt-4o-mini / gpt-4.1-mini (non-reasoning): the inverse — they TAKE a
//     temperature and REJECT the reasoning/verbosity params. So branch on family.
export function getGenerationParams(): {
  temperature: number | undefined;
  maxOutputTokens: number;
  providerOptions: Record<string, Record<string, string>> | undefined;
} {
  if (resolveProvider() === "openai") {
    if (getModelId().startsWith("gpt-5")) {
      return {
        temperature: undefined,
        // Reasoning tokens count against the output budget, so give more headroom
        // than the 2048 below — a few hundred reasoning tokens shouldn't be able
        // to truncate the visible answer. Still bounded to keep the long tail
        // under the 60s edge-function timeout; raise here if real answers truncate.
        maxOutputTokens: 4096,
        providerOptions: {
          openai: { reasoningEffort: "low", textVerbosity: "low" },
        },
      };
    }
    // Non-reasoning OpenAI models: temperature like Anthropic, no reasoning opts.
    return { temperature: 0.2, maxOutputTokens: 2048, providerOptions: undefined };
  }
  return {
    temperature: 0.2,
    // Any factual lookup answer should fit comfortably; if a real question
    // truncates, raise here rather than letting the long tail blow past the
    // 60s edge function timeout.
    maxOutputTokens: 2048,
    providerOptions: undefined,
  };
}

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
  if (resolveProvider() === "openai") {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not set");
    }
    // Default factory routes GPT-5 through the Responses API, which handles
    // reasoning output and reports cached/reasoning token counts via usage.
    return createOpenAI({ apiKey })(getModelId());
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  const modelId = getModelId();
  if (DEBUG_ANTHROPIC_REQ) {
    return createAnthropic({ apiKey, fetch: loggingFetch })(modelId);
  }
  return anthropic(modelId);
}
