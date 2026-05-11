import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from "ai";
import { z } from "zod";
import { auth } from "@/auth";
import {
  getModel,
  MODEL_MAX_OUTPUT_TOKENS,
  MODEL_TEMPERATURE,
} from "@/lib/ai/model";
import { SYSTEM_PROMPT } from "@/lib/ai/system-prompt";
import { tools } from "@/lib/ai/tools";
import { checkRateLimit } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/csrf";
import {
  appendMessages,
  createConversation,
  getConversation,
} from "@/lib/conversations";

export const maxDuration = 60;

// User-role parts must be text-only. `z.unknown()` would let a caller embed a
// forged `tool-result` part that the model treats as authoritative output —
// benign today (inventorySearch is read-only) but an authorization-spoofing
// vector the moment a mutating tool lands. Assistant parts stay permissive
// because the client replays tool-call/tool-result history from prior turns;
// the only real fix for that is server-persisted message state.
const UserTextPart = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const UserMessage = z.object({
  id: z.string(),
  role: z.literal("user"),
  parts: z.array(UserTextPart).min(1),
});

const AssistantMessage = z.object({
  id: z.string(),
  role: z.literal("assistant"),
  parts: z.array(z.unknown()),
});

const BodySchema = z.object({
  conversationId: z.string().uuid().optional(),
  messages: z
    .array(z.discriminatedUnion("role", [UserMessage, AssistantMessage]))
    .min(1)
    .max(50),
});

export async function POST(req: Request) {
  const devBypass =
    process.env.NODE_ENV === "development" &&
    process.env.VERCEL_ENV !== "production" &&
    process.env.ALLOW_UNAUTHED_DEV === "1";

  // Origin / Referer check. Belt to Auth.js's SameSite=Lax cookie suspenders
  // — Lax already blocks cross-site POSTs from carrying our auth cookie, but
  // an explicit Origin gate makes the intent legible and protects against
  // future cookie-attribute regressions. Skipped in dev so curl-style local
  // probes still work.
  if (!devBypass && !isSameOrigin(req.headers)) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  // Always read the session if one exists, regardless of dev bypass. The
  // bypass should mean "don't require a session in dev"; it must not also
  // mean "ignore a real signed-in user", or persistence silently no-ops
  // whenever ALLOW_UNAUTHED_DEV is set even for users who are signed in.
  let userId: string | null = null;
  const session = await auth();
  if (session?.user) {
    userId = session.user.id ?? session.user.email ?? null;
  } else if (!devBypass) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // Per-user (or per-IP fallback) message-rate cap. 20/min with bursts up to
  // 20 — caps runaway clients without tripping a rep typing fast.
  const limitKey =
    userId ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "anonymous";
  const rl = checkRateLimit(limitKey);
  if (!rl.allowed) {
    return Response.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { "Retry-After": String(rl.resetSeconds) },
      },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  let model;
  try {
    model = getModel();
  } catch (err) {
    console.error("[chat] model init failed:", err);
    return Response.json({ error: "server_misconfigured" }, { status: 500 });
  }

  // Persistence is best-effort and skipped in the dev bypass path — we still
  // want the stream to work in local dev without a populated user row. When a
  // userId is present we resolve (or create) the conversation up-front so the
  // onFinish callback can use a known id.
  let activeConversationId: string | null = null;
  const lastUserMessage = (() => {
    const all = parsed.data.messages;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].role === "user") return all[i];
    }
    return null;
  })();

  if (userId && lastUserMessage) {
    try {
      if (parsed.data.conversationId) {
        const conv = await getConversation(userId, parsed.data.conversationId);
        if (!conv) {
          return Response.json({ error: "not_found" }, { status: 404 });
        }
        activeConversationId = conv.id;
      } else {
        const firstText = ((): string => {
          for (const p of lastUserMessage.parts) {
            const part = p as { type?: string; text?: string };
            if (part.type === "text" && typeof part.text === "string") {
              return part.text;
            }
          }
          return "";
        })();
        const conv = await createConversation(userId, firstText);
        activeConversationId = conv.id;
      }
      // Persist the just-sent user message immediately so a stream that fails
      // mid-flight still has the question recorded.
      await appendMessages(userId, activeConversationId, [
        {
          role: "user",
          parts: lastUserMessage.parts,
          model: null,
        },
      ]);
    } catch (err) {
      console.error("[chat] persistence (pre-stream) failed:", err);
      // Keep going — chat must not be blocked by a DB issue. The conversation
      // id stays null so onFinish skips its write too.
      activeConversationId = null;
    }
  }

  const result = streamText({
    model,
    // SystemModelMessage form lets us mark the prompt for Anthropic's
    // ephemeral prompt cache. The system prompt + tool definitions are
    // stable across turns; caching them drops cost ~90% on cached input
    // tokens and shaves measurable latency off every turn after the first.
    system: {
      role: "system",
      content: SYSTEM_PROMPT,
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
    },
    messages: await convertToModelMessages(parsed.data.messages as UIMessage[]),
    tools,
    temperature: MODEL_TEMPERATURE,
    maxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
    stopWhen: stepCountIs(4),
    abortSignal: req.signal,
    onError: ({ error }) => {
      console.error("[chat] stream error:", mapToFriendlyCode(error), error);
    },
    onFinish: ({ usage, text, providerMetadata }) => {
      const anthMeta = providerMetadata?.anthropic as
        | { cacheCreationInputTokens?: number | null; cacheReadInputTokens?: number | null }
        | undefined;
      console.log("[chat] usage", {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        reasoningTokens: usage.reasoningTokens,
        totalTokens: usage.totalTokens,
        cacheCreationInputTokens: anthMeta?.cacheCreationInputTokens ?? null,
        cacheReadInputTokens: anthMeta?.cacheReadInputTokens ?? null,
      });
      // Belt-and-braces leak detector. The proxy already strips IPs/hostnames
      // from error envelopes, but an LLM can sometimes echo data it saw in a
      // tool result. If anything that looks like an internal address makes it
      // into the rendered answer, log it loudly so we notice in journalctl.
      const leak = detectInternalLeak(text);
      if (leak) {
        console.warn("[chat] possible internal-address leak in assistant output:", leak);
      }
    },
  });

  return result.toUIMessageStreamResponse({
    onError: (err) => mapToFriendlyCode(err),
    onFinish: async ({ responseMessage, isAborted }) => {
      if (isAborted || !userId || !activeConversationId) return;
      try {
        const usage = await result.usage;
        await appendMessages(userId, activeConversationId, [
          {
            role: "assistant",
            parts: responseMessage.parts,
            model: process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-6",
            usage: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cachedInputTokens: usage.cachedInputTokens,
              totalTokens: usage.totalTokens,
            },
          },
        ]);
      } catch (err) {
        console.error("[chat] persistence (post-stream) failed:", err);
      }
    },
  });
}

// IPv4 in the RFC1918 private-network ranges (10/8, 172.16/12, 192.168/16) or
// a hostname that contains "internal" / "lan" / ".local". Returns the first
// match so the operator can grep for it in logs.
function detectInternalLeak(text: string): string | null {
  if (!text) return null;
  const ipv4 =
    /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/.exec(
      text,
    );
  if (ipv4) return ipv4[0];
  const host = /\b[a-z0-9-]+\.(?:internal|lan|local)\b/i.exec(text);
  if (host) return host[0];
  return null;
}

// Tag stream errors with codes the composer maps to friendly messages
// (composer.friendlyErrorMessage). The runtime only forwards the .message
// string to the client, so we return a stable code-style string and the
// composer matches on substring.
function mapToFriendlyCode(error: unknown): string {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const lower = message.toLowerCase();
  if (
    lower.includes("api key") ||
    lower.includes("unauthorized") ||
    lower.includes("authentication") ||
    lower.includes("invalid_api_key") ||
    lower.includes("401")
  ) {
    return "provider_auth";
  }
  if (
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("too many requests") ||
    lower.includes("429")
  ) {
    return "rate_limited";
  }
  if (
    lower.includes("overloaded") ||
    lower.includes("unavailable") ||
    lower.includes("503") ||
    lower.includes("502") ||
    lower.includes("504") ||
    lower.includes("timeout")
  ) {
    return "provider_unavailable";
  }
  return "stream_error";
}
