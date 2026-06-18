import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  type LanguageModelUsage,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { activeSession } from "@/auth";
import { getActiveProvider, getGenerationParams, getModel, getModelId } from "@/lib/ai/model";
import { logChatError } from "@/lib/chat-errors";
import { SYSTEM_PROMPT } from "@/lib/ai/system-prompt";
import { buildTools } from "@/lib/ai/tools";
import { isExcelMimeType, MAX_UPLOAD_CEILING_BYTES, ownsAttachmentUrl } from "@/lib/blob";
import { fetchAndConvertExcel } from "@/lib/excel";
import { fetchAndConvertOffice, isOfficeDocMimeType } from "@/lib/office";
import { effectiveScopes, loadScopeCatalog } from "@/lib/scopes";
import { getTrialStatus } from "@/lib/trial";
import { checkRateLimit } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/csrf";
import {
  appendMessages,
  createConversation,
  getConversation,
  supersedeMessagesFrom,
} from "@/lib/conversations";

// 300s, not 60: a multi-step ERP chain (describeView → several viewsQuery
// pages → aggregate, each up to PROXY_TIMEOUT_MS=25s) can legitimately exceed
// 60s, and Vercel killing the function mid-stream is exactly the "tool calls
// ran, then nothing" stall. Requires Fluid Compute (the default for current
// Vercel projects); if a deploy rejects this value, the project is on the
// legacy runtime — enable Fluid Compute rather than lowering this back.
export const maxDuration = 300;

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
  /^(image\/(png|jpe?g|webp|gif)|application\/pdf|text\/(plain|csv|tab-separated-values)|application\/vnd\.openxmlformats-officedocument\.(spreadsheetml\.sheet|wordprocessingml\.document|presentationml\.presentation)|application\/vnd\.ms-excel)$/;

const UserFilePart = z.object({
  type: z.literal("file"),
  mediaType: z
    .string()
    .max(128)
    .regex(ALLOWED_FILE_MIME_RE, "unsupported mediaType"),
  url: z.string().url().max(1024),
  filename: z.string().max(255),
  // Secondary guard on an already-uploaded file's declared size. The upload
  // route is the real gate (it enforces the admin-configured limit on the
  // actual bytes); here we only reject anything above the absolute ceiling.
  size: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_UPLOAD_CEILING_BYTES)
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

// Walk a user message and replace file parts the model can't read natively
// with synthesized text parts:
//   - Excel (.xlsx/.xls) → CSV
//   - Word (.docx) / PowerPoint (.pptx) → extracted plain text
// The original file part is still in `message.parts` saved to the DB
// (persistence happens upstream of this), so the user-bubble chip keeps its
// download link in history; the model just sees the text.
//
// PDFs and images flow through unchanged — providers accept them natively and
// the AI SDK's convertToModelMessages handles the provider mapping.
async function expandAttachmentsForModel(
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
    } else if (part.type === "file" && isOfficeDocMimeType(part.mediaType)) {
      try {
        const text = await fetchAndConvertOffice(part.url, part.mediaType);
        out.push({
          type: "text",
          text: text
            ? `Attached document \`${part.filename}\` (extracted text):\n\n${text}`
            : `[Attached document \`${part.filename}\` contained no extractable text — it may be image-only. Tell the user to share a text-based version or paste the relevant content.]`,
        });
      } catch (err) {
        console.error("[chat] office conversion failed:", part.filename, err);
        out.push({
          type: "text",
          text: `[Attached document \`${part.filename}\` could not be read. Tell the user the file may be corrupted and ask them to retry.]`,
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

  // TEMPORARY trial spend gate. Deployment-wide, hard-stops EVERYONE (admins
  // included) once estimated spend crosses the limit. The limit is provisioned
  // out-of-band (no in-app control to raise it or disable the gate). Fail-open
  // on a DB hiccup — a billing estimate must never take the whole chat down.
  // Remove this block when the trial gate is retired (see schema.ts `trialBudget`).
  try {
    const trial = await getTrialStatus();
    if (trial.exhausted) {
      return Response.json({ error: "trial_limit_reached" }, { status: 402 });
    }
  } catch (err) {
    console.error("[chat] trial gate check failed (failing open):", err);
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

  // The query text that triggered this turn, captured once up-front so every
  // error-log site (setup failure, stream failure, blank answer) can record
  // *what was asked* even when the turn never gets persisted. getModelId/
  // getActiveProvider read env and don't throw, so they're safe to call before
  // the model is constructed.
  const lastUserText = lastUserTextOf(parsed.data.messages);
  const activeProvider = getActiveProvider();
  const activeModelId = getModelId();

  let model;
  try {
    model = getModel();
  } catch (err) {
    console.error("[chat] model init failed:", err);
    // Persist before returning — a misconfigured/failed provider init is a
    // real "Something went wrong" cause worth seeing at /admin/errors.
    await logChatError({
      phase: "setup",
      error: err,
      code: "server_misconfigured",
      httpStatus: 500,
      userId,
      provider: activeProvider,
      model: activeModelId,
      query: lastUserText,
    });
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
      m.role === "user" ? await expandAttachmentsForModel(m) : m,
    ),
  );

  // Inject today's date (Pacific, matching P21's wall clock) so the model
  // doesn't infer "now" from its training cutoff when writing time-relative
  // filters like "the last 30 days" or "shipping this week". Computed every
  // request so the anchor moves with the actual server clock; cache busts
  // at midnight Pacific, which is well below the ephemeral cache TTL anyway.
  const todayPacific = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const gen = getGenerationParams();

  // SystemModelMessage form lets us mark the prompt for Anthropic's
  // ephemeral prompt cache. The system prompt + tool definitions are
  // stable across turns; caching them drops cost ~90% on cached input
  // tokens and shaves measurable latency off every turn after the first.
  // The marker is namespaced under `anthropic`, so OpenAI ignores it —
  // OpenAI models do prefix caching automatically with no marker needed.
  const systemMessage = {
    role: "system" as const,
    content:
      `Today is ${todayPacific} (Pacific time, America/Los_Angeles). ` +
      `Use this as the anchor for any "today", "yesterday", "this week", ` +
      `"last N days", or "next N days" filter you write. Do NOT infer the ` +
      `date from your training data — the injected date above is authoritative.\n\n` +
      SYSTEM_PROMPT,
    providerOptions: {
      anthropic: { cacheControl: { type: "ephemeral" } },
    },
  };
  const modelMessages = await convertToModelMessages(modelFacingMessages as UIMessage[]);
  const tools = buildTools(scopes, scopeCatalog);

  // Raw errors captured from the stream callbacks. toUIMessageStream's onError
  // only yields the MAPPED friendly string to the client; these hold the
  // underlying provider error (status, body, stack) for /admin/errors. Set in
  // the onError callbacks, read after the corresponding stream drains.
  let streamErrorRaw: unknown = null;
  let recoveryErrorRaw: unknown = null;

  const result = streamText({
    model,
    system: systemMessage,
    messages: modelMessages,
    tools,
    // Provider-specific: temperature/verbosity/reasoning differ between
    // Anthropic and GPT-5. See getGenerationParams in lib/ai/model.ts.
    temperature: gen.temperature,
    maxOutputTokens: gen.maxOutputTokens,
    providerOptions: gen.providerOptions,
    // 10 steps = enough headroom for: describeView → multi-step viewsQuery
    // chain (e.g. resolve location IDs, then transfers between them) → one or
    // two retries on filter syntax → final synthesis. Originally 8 (per
    // TESTING.md), tightened to 4 at some point — but with describeView in
    // the loop the model legitimately needs more steps before answering.
    stopWhen: stepCountIs(10),
    // Safety net against a blank reply: on the final allowed step, force the
    // model to answer in text instead of calling yet another tool. Without
    // this, a model that loops on tool calls (observed with gpt-4o-mini
    // repeating one search 10×) burns the whole step budget and emits NO
    // assistant text — the user sees tool calls and then nothing. Forcing
    // toolChoice 'none' on the last step guarantees a synthesized reply from
    // whatever results it has. Model-agnostic; harmless when the model
    // finishes earlier on its own. (The step-budget case. The other blank-
    // reply case — the model stopping early with no text — is handled by the
    // recovery pass in the stream below.)
    prepareStep: ({ stepNumber }) =>
      stepNumber >= 9 ? { toolChoice: "none" } : {},
    abortSignal: req.signal,
    onError: ({ error }) => {
      streamErrorRaw = error;
      console.error("[chat] stream error:", mapToFriendlyCode(error), error);
    },
    onFinish: ({ totalUsage, text, providerMetadata }) => {
      const anthMeta = providerMetadata?.anthropic as
        | { cacheCreationInputTokens?: number | null; cacheReadInputTokens?: number | null }
        | undefined;
      console.log("[chat] usage", {
        inputTokens: totalUsage.inputTokens,
        outputTokens: totalUsage.outputTokens,
        cachedInputTokens: totalUsage.cachedInputTokens,
        reasoningTokens: totalUsage.reasoningTokens,
        totalTokens: totalUsage.totalTokens,
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

  // Usage from the recovery pass (below), if it ran — folded into the
  // persisted usage so the trial spend gate sees the whole turn. Set inside
  // execute(), read in onFinish(); safe because onFinish only fires after
  // execute() has completed.
  let recoveryUsage: LanguageModelUsage | null = null;

  const stream = createUIMessageStream({
    // Forward the agent loop chunk-by-chunk instead of toUIMessageStreamResponse
    // so we can append a recovery pass to the SAME assistant message when the
    // loop produces no visible text. gpt-4.1-mini sometimes ends its tool loop
    // on a tool result with finishReason "stop" and zero text — under Sonnet
    // this class never fired, with OpenAI it's the "did all its ERP search,
    // then nothing" stall. for-await (not writer.merge) keeps chunk ordering
    // strict across the two phases.
    execute: async ({ writer }) => {
      let sawText = false;
      let sawError = false;
      // Tool calls that returned before the failure — the difference between
      // "died immediately" and "ran N ERP searches, then stalled" in the log.
      let toolCallCount = 0;
      // sendFinish: false — we close the message ourselves once we know
      // whether the recovery pass needs to run.
      for await (const chunk of result.toUIMessageStream({
        sendFinish: false,
        onError: mapToFriendlyCode,
      })) {
        if (chunk.type === "text-delta" && chunk.delta.trim().length > 0) {
          sawText = true;
        } else if (chunk.type === "error") {
          sawError = true;
        } else if (chunk.type === "tool-output-available") {
          toolCallCount += 1;
        }
        writer.write(chunk);
      }

      // The main agent loop errored mid-stream — the "Something went wrong"
      // class. Persist the raw provider error + the query for /admin/errors.
      if (sawError) {
        await logChatError({
          phase: "stream",
          error: streamErrorRaw,
          code: mapToFriendlyCode(streamErrorRaw),
          userId,
          conversationId: activeConversationId,
          provider: activeProvider,
          model: activeModelId,
          query: lastUserText,
          toolCallCount,
        });
      }

      // Blank-answer recovery: the loop finished cleanly but emitted no text.
      // Re-prompt once with the gathered tool results and tool use disabled —
      // the model MUST synthesize an answer from what it already has. Skipped
      // when the stream errored (the composer shows the mapped error + Retry;
      // a second model call would just fail the same way) or was aborted.
      if (!sawText && !sawError && !req.signal.aborted) {
        console.warn("[chat] empty final answer — running synthesis recovery pass");
        let recoverySawText = false;
        try {
          const { messages: agentMessages } = await result.response;
          const recovery = streamText({
            model,
            system: systemMessage,
            messages: [
              ...modelMessages,
              ...agentMessages,
              {
                role: "user" as const,
                content:
                  "Answer my question now using the tool results you already retrieved above. " +
                  "Do not call any more tools. If the results were insufficient, say what you " +
                  "found and what you'd need to look up next.",
              },
            ],
            // Tools stay declared (some providers reject tool-call history
            // without them) but toolChoice none forces a text-only reply.
            tools,
            toolChoice: "none",
            temperature: gen.temperature,
            maxOutputTokens: gen.maxOutputTokens,
            providerOptions: gen.providerOptions,
            abortSignal: req.signal,
            onError: ({ error }) => {
              recoveryErrorRaw = error;
              console.error("[chat] recovery stream error:", mapToFriendlyCode(error), error);
            },
          });
          for await (const chunk of recovery.toUIMessageStream({
            sendStart: false,
            sendFinish: false,
            onError: mapToFriendlyCode,
          })) {
            if (chunk.type === "text-delta" && chunk.delta.trim().length > 0) {
              recoverySawText = true;
            }
            writer.write(chunk);
          }
          recoveryUsage = await recovery.totalUsage;
        } catch (err) {
          recoveryErrorRaw = recoveryErrorRaw ?? err;
          console.error("[chat] recovery pass failed:", err);
        }

        // The turn produced no visible answer even after recovery. Two cases,
        // both logged so a recurring blank-answer pattern is visible at
        // /admin/errors (not just a silent empty bubble):
        //   - recovery itself errored → the raw error.
        //   - recovery ran clean but still emitted nothing → soft 'blank_answer'.
        if (recoveryErrorRaw) {
          await logChatError({
            phase: "recovery",
            error: recoveryErrorRaw,
            code: mapToFriendlyCode(recoveryErrorRaw),
            userId,
            conversationId: activeConversationId,
            provider: activeProvider,
            model: activeModelId,
            query: lastUserText,
            toolCallCount,
          });
        } else if (!recoverySawText && !req.signal.aborted) {
          await logChatError({
            phase: "blank_answer",
            code: "blank_answer",
            userId,
            conversationId: activeConversationId,
            provider: activeProvider,
            model: activeModelId,
            query: lastUserText,
            toolCallCount,
          });
        }
      }
      writer.write({ type: "finish" });
    },
    onError: mapToFriendlyCode,
    onFinish: async ({ responseMessage, isAborted }) => {
      if (isAborted || !userId || !activeConversationId) return;
      try {
        // totalUsage, not usage: usage is the LAST step only, which silently
        // undercounted every multi-step tool turn — the trial spend gate and
        // the admin usage page were seeing a fraction of real provider spend.
        const usage = await result.totalUsage;
        const extra = recoveryUsage;
        const sum = (a: number | undefined, b: number | undefined) =>
          a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
        await appendMessages(userId, activeConversationId, [
          {
            role: "assistant",
            parts: responseMessage.parts,
            model: getModelId(),
            usage: {
              inputTokens: sum(usage.inputTokens, extra?.inputTokens),
              outputTokens: sum(usage.outputTokens, extra?.outputTokens),
              cachedInputTokens: sum(usage.cachedInputTokens, extra?.cachedInputTokens),
              totalTokens: sum(usage.totalTokens, extra?.totalTokens),
            },
          },
        ]);
      } catch (err) {
        console.error("[chat] persistence (post-stream) failed:", err);
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}

// The text of the most recent user message in the request — the query that
// triggered this turn. Used only for the diagnostic error log, so it walks the
// parsed messages directly (the model-facing expansion hasn't run yet) and
// returns null when the last user turn is attachments-only.
function lastUserTextOf(
  messages: z.infer<typeof BodySchema>["messages"],
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    for (const part of m.parts) {
      if (part.type === "text" && part.text.trim().length > 0) return part.text;
    }
    return null;
  }
  return null;
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
  // Input that overflowed the model's context window — most often an attached
  // document too large to read in one turn. Both providers word this
  // differently: OpenAI "maximum context length is N tokens" /
  // "context_length_exceeded"; Anthropic "prompt is too long: N tokens >
  // 200000 maximum". Checked early so it isn't swallowed by the generic
  // stream_error fallback (it shares no wording with the quota/rate strings).
  if (
    lower.includes("context length") ||
    lower.includes("context_length_exceeded") ||
    lower.includes("context window") ||
    lower.includes("maximum context") ||
    lower.includes("prompt is too long")
  ) {
    return "context_too_large";
  }
  // Checked BEFORE rate_limited: OpenAI returns quota exhaustion as a 429
  // with "insufficient_quota" / "exceeded your current quota … billing",
  // which is NOT transient — "try again in a moment" is the wrong advice
  // when the provider account is out of credits. Anthropic's equivalent is
  // "credit balance is too low".
  if (
    lower.includes("quota") ||
    lower.includes("billing") ||
    lower.includes("credit balance")
  ) {
    return "provider_quota";
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
