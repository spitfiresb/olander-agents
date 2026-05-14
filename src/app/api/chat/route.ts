import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from "ai";
import { z } from "zod";
import { activeSession } from "@/auth";
import {
  getModel,
  MODEL_MAX_OUTPUT_TOKENS,
  MODEL_TEMPERATURE,
} from "@/lib/ai/model";
import { SYSTEM_PROMPT } from "@/lib/ai/system-prompt";
import { buildTools } from "@/lib/ai/tools";
import { isExcelMimeType, ownsAttachmentUrl } from "@/lib/blob";
import { fetchAndConvertExcel } from "@/lib/excel";
import { effectiveScopes, loadScopeCatalog } from "@/lib/scopes";
import { checkRateLimit } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/csrf";
import {
  appendMessages,
  createConversation,
  getConversation,
  supersedeMessagesFrom,
} from "@/lib/conversations";

export const maxDuration = 60;

// User-role parts are text OR file — never anything else. The strict shape
// stops a caller from embedding a forged `tool-result` part that the model
// would treat as authoritative output (benign today, but an authorization-
// spoofing vector the moment a mutating tool lands). The discriminated union
// is the deliberately narrow relaxation needed for Stage 2 attachments;
// dropping back to `z.unknown()` would recreate the CVE-class regression
// fixed in 760db8a / TESTING.md §2.
//
// Assistant parts stay permissive because the client replays tool-call /
// tool-result history from prior turns; the only real fix for that is
// server-persisted message state.
const UserTextPart = z.object({
  type: z.literal("text"),
  text: z.string(),
});

// Mirror the allowlist in src/lib/blob.ts (isAllowedMimeType). Anchored at
// both ends so `text/foo` style smuggling doesn't slip past — only the
// enumerated MIMEs are accepted. The regex is duplicated by intent: the
// schema mirror in src/app/api/chat/__tests__/body-schema.test.ts copies
// it verbatim, and a shared import would couple the schema test to the
// blob module's side effects.
const ALLOWED_FILE_MIME_RE =
  /^(image\/(png|jpe?g|webp|gif)|application\/pdf|text\/(plain|csv|tab-separated-values)|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|application\/vnd\.ms-excel)$/;

const UserFilePart = z.object({
  type: z.literal("file"),
  mediaType: z
    .string()
    .max(128)
    .regex(ALLOWED_FILE_MIME_RE, "unsupported mediaType"),
  url: z.string().url().max(1024),
  filename: z.string().max(255),
  size: z
    .number()
    .int()
    .nonnegative()
    .max(10 * 1024 * 1024)
    .optional(),
});

const UserMessage = z.object({
  id: z.string(),
  role: z.literal("user"),
  parts: z
    .array(z.discriminatedUnion("type", [UserTextPart, UserFilePart]))
    .min(1),
});

const AssistantMessage = z.object({
  id: z.string(),
  role: z.literal("assistant"),
  parts: z.array(z.unknown()),
});

const BodySchema = z.object({
  conversationId: z.string().uuid().optional(),
  // Edit-and-resend hook. When set, every message in the conversation with
  // createdAt >= this message's createdAt is stamped supersededAt = now()
  // before the new user turn is appended (see `supersedeMessagesFrom`).
  // Ownership is verified inside the helper — a forged id on someone else's
  // conversation is a no-op, not a leak.
  //
  // Format: any reasonable string, not strictly UUID. The AI SDK generates
  // ~16-char base64-ish ids client-side; old DB rows use UUIDs from drizzle's
  // $defaultFn. The persistence path (appendMessages) preserves the client
  // id when provided so the lookup matches on either format.
  editedMessageId: z.string().min(1).max(128).optional(),
  messages: z
    .array(z.discriminatedUnion("role", [UserMessage, AssistantMessage]))
    .min(1)
    .max(50),
});

type ParsedUserMessage = z.infer<typeof UserMessage>;
type ParsedUserPart = ParsedUserMessage["parts"][number];

// Walk a user message and replace Excel file parts with synthesized CSV
// text parts. The original file part is still in `message.parts` saved to
// the DB (persistence happens upstream of this), so the user-bubble chip
// keeps its download link in history; the model just sees the CSV.
//
// PDFs and images flow through unchanged — Anthropic accepts them natively
// and the AI SDK's convertToModelMessages handles the provider mapping.
async function expandExcelPartsForModel(
  message: ParsedUserMessage,
): Promise<ParsedUserMessage> {
  const out: ParsedUserPart[] = [];
  for (const part of message.parts) {
    if (part.type === "file" && isExcelMimeType(part.mediaType)) {
      try {
        const csv = await fetchAndConvertExcel(part.url);
        out.push({
          type: "text",
          text: `Attached spreadsheet \`${part.filename}\` (converted from ${part.mediaType} to CSV):\n\n${csv}`,
        });
      } catch (err) {
        console.error("[chat] excel conversion failed:", part.filename, err);
        out.push({
          type: "text",
          text: `[Attached spreadsheet \`${part.filename}\` could not be read. Tell the user the file may be corrupted and ask them to retry.]`,
        });
      }
    } else {
      out.push(part);
    }
  }
  return { ...message, parts: out };
}

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
  const session = await activeSession();
  if (session?.user) {
    userId = session.user.id ?? session.user.email ?? null;
  } else if (!devBypass) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // Resolve the caller's data-access scopes once per request. Dev-bypass +
  // no session = "all" so local probes still hit P21; otherwise we read the
  // session's role + per-member scope override and feed it into buildTools.
  // The scope catalog is loaded from DB once here and threaded through every
  // tool so each execute() can run the allow check without another query.
  const scopeCatalog = await loadScopeCatalog();
  const scopes = session?.user
    ? effectiveScopes(
        session.user.role,
        session.user.dataScopes ?? null,
        scopeCatalog,
      )
    : "all";

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

  // Ownership / SSRF gate for file parts. Every file URL the client sent
  // must live under chat-attachments/{callingUserId}/ on a Vercel Blob host.
  // The schema already restricted the MIME; this prevents a client from
  // forging a URL pointing to another user's blob (or an arbitrary host
  // that the chat route would then fetch server-side during Excel→CSV).
  //
  // No userId means dev bypass — there's no namespace to verify against,
  // so reject any file parts in that mode rather than letting them through.
  for (const m of parsed.data.messages) {
    if (m.role !== "user") continue;
    for (const part of m.parts) {
      if (part.type !== "file") continue;
      if (!userId || !ownsAttachmentUrl(part.url, userId)) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
    }
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
      // Edit-and-resend: stamp every message from the edited turn forward
      // with supersededAt = now() so they vanish from user-facing reads on
      // reload. Order matters — must run before the new user turn lands,
      // otherwise the fresh insert gets caught in the same sweep. Gate on
      // both ids: an edit referring to a not-yet-created conversation is
      // nonsense, so we ignore editedMessageId in that case. Failures here
      // produce a duplicate-history UX bug on reload but don't block the
      // chat — surface in logs and continue.
      if (parsed.data.editedMessageId && parsed.data.conversationId) {
        try {
          await supersedeMessagesFrom(
            userId,
            activeConversationId,
            parsed.data.editedMessageId,
          );
        } catch (err) {
          console.error("[chat] supersede failed:", err);
        }
      }
      // Persist the just-sent user message immediately so a stream that fails
      // mid-flight still has the question recorded. We forward the client's
      // message id so subsequent edit-and-resend requests can reference the
      // row by the id the client already knows — otherwise the client's
      // in-memory id (from the AI SDK) and the DB id (drizzle UUID) would
      // disagree and supersedeMessagesFrom would no-op.
      await appendMessages(userId, activeConversationId, [
        {
          id: lastUserMessage.id,
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

  // Build the model-facing messages array. Excel file parts are swapped
  // for synthesized CSV text parts (Anthropic doesn't accept .xlsx). The
  // persisted message (above) still carries the original file part with
  // its URL, so the user-bubble chip keeps its download link on reload.
  const modelFacingMessages = await Promise.all(
    parsed.data.messages.map(async (m) =>
      m.role === "user" ? await expandExcelPartsForModel(m) : m,
    ),
  );

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
    messages: await convertToModelMessages(modelFacingMessages as UIMessage[]),
    tools: buildTools(scopes, scopeCatalog),
    temperature: MODEL_TEMPERATURE,
    maxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
    // 10 steps = enough headroom for: describeView → multi-step viewsQuery
    // chain (e.g. resolve location IDs, then transfers between them) → one or
    // two retries on filter syntax → final synthesis. Originally 8 (per
    // TESTING.md), tightened to 4 at some point — but with describeView in
    // the loop the model legitimately needs more steps before answering, and
    // hitting the cap means no final assistant text gets emitted.
    stopWhen: stepCountIs(10),
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
