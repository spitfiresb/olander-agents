import { db } from "@/db";
import { chatErrors } from "@/db/schema";

// Persisted diagnostics for FAILED chat turns. The chat route surfaces only a
// friendly code to the user; this module keeps the raw error + the query that
// triggered it in the `chat_error` table (see schema.ts) so admins can diagnose
// the "Something went wrong" reports at /admin/errors. Everything here is
// fail-safe: a logging failure must never compound the user-facing error it is
// recording.

// Bounds so a giant provider error body or stack can't bloat a row. The
// message/stack carry the real diagnostic signal (status code, provider detail);
// the query is the user's own text, already short in practice.
const MAX_MESSAGE = 2000;
const MAX_STACK = 4000;
const MAX_QUERY = 1000;

export type ChatErrorPhase = "setup" | "stream" | "recovery" | "blank_answer";

export type ChatErrorInput = {
  phase: ChatErrorPhase;
  // Raw thrown value (Error | string | anything). Optional: 'blank_answer' is a
  // soft failure with no exception.
  error?: unknown;
  code?: string | null;
  httpStatus?: number | null;
  userId?: string | null;
  conversationId?: string | null;
  provider?: string | null;
  model?: string | null;
  query?: string | null;
  toolCallCount?: number | null;
  finishReason?: string | null;
};

function trunc(s: string | null | undefined, max: number): string | null {
  if (s == null) return null;
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

// Pure extraction (no DB) so it's unit-testable. Pulls name/message/stack off an
// unknown thrown value and bounds every string.
export function describeError(error: unknown): {
  name: string | null;
  message: string | null;
  stack: string | null;
} {
  if (error instanceof Error) {
    return {
      name: error.name || null,
      message: trunc(error.message, MAX_MESSAGE),
      stack: trunc(error.stack ?? null, MAX_STACK),
    };
  }
  if (typeof error === "string") {
    return { name: null, message: trunc(error, MAX_MESSAGE), stack: null };
  }
  if (error == null) return { name: null, message: null, stack: null };
  try {
    return { name: null, message: trunc(JSON.stringify(error), MAX_MESSAGE), stack: null };
  } catch {
    return { name: null, message: trunc(String(error), MAX_MESSAGE), stack: null };
  }
}

export function truncateQuery(q: string | null | undefined): string | null {
  // Empty / whitespace-only → null ("no query text"), not an empty string.
  if (!q || q.trim().length === 0) return null;
  return trunc(q, MAX_QUERY);
}

// Persist one failed-turn diagnostic row. NEVER throws. Callers await it inside
// the stream's execute() so the write lands before the serverless function
// freezes, but its own failures are swallowed (logged to stderr only).
export async function logChatError(input: ChatErrorInput): Promise<void> {
  try {
    const { name, message, stack } = describeError(input.error);
    await db.insert(chatErrors).values({
      phase: input.phase,
      code: input.code ?? null,
      httpStatus: input.httpStatus ?? null,
      userId: input.userId ?? null,
      conversationId: input.conversationId ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      query: truncateQuery(input.query),
      toolCallCount: input.toolCallCount ?? null,
      finishReason: input.finishReason ?? null,
      errorName: name,
      errorMessage: message,
      errorStack: stack,
    });
  } catch (err) {
    console.error("[chat-error-log] failed to persist chat error (swallowed):", err);
  }
}
