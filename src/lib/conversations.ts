import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages, toolCalls } from "@/db/schema";

// Owned-by-user CRUD for chat history. Every read and write filters on the
// caller's userId — passing the wrong userId at any layer is a data leak.
// All routes / actions must call these helpers; never query the chat tables
// directly with an externally supplied id.

const TITLE_MAX_LEN = 60;

export function deriveTitleFromText(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return "Untitled chat";
  return trimmed.length > TITLE_MAX_LEN
    ? trimmed.slice(0, TITLE_MAX_LEN - 1) + "…"
    : trimmed;
}

export async function listConversations(userId: string) {
  return db
    .select({
      id: conversations.id,
      title: conversations.title,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .where(and(eq(conversations.userId, userId), isNull(conversations.deletedAt)))
    .orderBy(desc(conversations.updatedAt));
}

export async function createConversation(userId: string, title: string) {
  const [row] = await db
    .insert(conversations)
    .values({ userId, title: deriveTitleFromText(title) })
    .returning();
  return row;
}

export async function getConversation(userId: string, conversationId: string) {
  const [conv] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, userId),
        isNull(conversations.deletedAt),
      ),
    );
  return conv ?? null;
}

export async function loadMessages(userId: string, conversationId: string) {
  const conv = await getConversation(userId, conversationId);
  if (!conv) return null;
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt);
  return rows;
}

export async function renameConversation(
  userId: string,
  conversationId: string,
  newTitle: string,
) {
  const title = deriveTitleFromText(newTitle);
  const result = await db
    .update(conversations)
    .set({ title, updatedAt: new Date() })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, userId),
        isNull(conversations.deletedAt),
      ),
    )
    .returning({ id: conversations.id });
  return result.length > 0;
}

export async function softDeleteConversation(
  userId: string,
  conversationId: string,
) {
  const result = await db
    .update(conversations)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, userId),
        isNull(conversations.deletedAt),
      ),
    )
    .returning({ id: conversations.id });
  return result.length > 0;
}

export type PersistedMessage = {
  role: "user" | "assistant" | "system";
  parts: unknown;
  model?: string | null;
  usage?: unknown;
};

export async function appendMessages(
  userId: string,
  conversationId: string,
  newMessages: PersistedMessage[],
) {
  if (newMessages.length === 0) return;
  // Re-check ownership at write time — the conversationId came from the
  // client, so a stolen UUID without a matching userId must not be written
  // to. The where-filter on the conversations table is the gate.
  const conv = await getConversation(userId, conversationId);
  if (!conv) throw new Error("conversation_not_found");

  // Sequential inserts instead of a transaction: `drizzle-orm/neon-http`
  // (HTTP fetch transport, the one we use everywhere else) does not support
  // multi-statement transactions. Partial-failure here means an orphaned
  // message row without its tool_call audit entries, or a missing
  // updatedAt bump — both tolerable on a denormalized audit log, and worth
  // not adding a second DB driver just for atomicity.
  const inserted = await db
    .insert(messages)
    .values(
      newMessages.map((m) => ({
        conversationId,
        role: m.role,
        parts: m.parts as object,
        model: m.model ?? null,
        usage: (m.usage ?? null) as object | null,
      })),
    )
    .returning({ id: messages.id, parts: messages.parts, role: messages.role });

  const toolRows: (typeof toolCalls.$inferInsert)[] = [];
  for (const row of inserted) {
    if (row.role !== "assistant") continue;
    const parts = row.parts as unknown[];
    for (const part of parts) {
      if (!isToolPartShape(part)) continue;
      const toolName = part.type.replace(/^tool-/, "");
      toolRows.push({
        messageId: row.id,
        conversationId,
        userId,
        toolName,
        args: (part.input ?? null) as object | null,
        result: (part.output ?? null) as object | null,
        errorCode:
          typeof part.output === "object" &&
          part.output !== null &&
          "error" in part.output &&
          typeof (part.output as { error?: unknown }).error === "string"
            ? ((part.output as { error: string }).error)
            : null,
        durationMs: null,
      });
    }
  }
  if (toolRows.length > 0) {
    await db.insert(toolCalls).values(toolRows);
  }
  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

function isToolPartShape(part: unknown): part is {
  type: string;
  input?: unknown;
  output?: unknown;
} {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    typeof (part as { type: unknown }).type === "string" &&
    (part as { type: string }).type.startsWith("tool-")
  );
}

export async function exportConversationMarkdown(
  userId: string,
  conversationId: string,
): Promise<string | null> {
  const conv = await getConversation(userId, conversationId);
  if (!conv) return null;
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt);

  const lines: string[] = [];
  lines.push(`# ${conv.title}`);
  lines.push(``);
  lines.push(`Exported ${new Date().toISOString()}`);
  lines.push(``);
  for (const row of rows) {
    lines.push(row.role === "user" ? "## You" : "## Assistant");
    const parts = (row.parts ?? []) as unknown[];
    for (const part of parts) {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        (part as { type: unknown }).type === "text" &&
        "text" in part &&
        typeof (part as { text: unknown }).text === "string"
      ) {
        lines.push((part as { text: string }).text);
      } else if (isToolPartShape(part)) {
        const tool = part.type.replace(/^tool-/, "");
        lines.push(`> tool: ${tool}`);
      }
    }
    lines.push(``);
  }
  return lines.join("\n");
}

// Daily token/usage rollup for /admin/usage. Sum across users; the route is
// admin-gated and intended for spend monitoring, not per-user analytics.
export async function dailyUsage(daysBack = 30) {
  // Group by date(createdAt) in postgres so we don't pull every row to JS.
  return db
    .select({
      day: sql<string>`to_char(${messages.createdAt}, 'YYYY-MM-DD')`,
      messages: sql<number>`count(*)`.mapWith(Number),
      inputTokens: sql<number>`coalesce(sum((${messages.usage}->>'inputTokens')::int), 0)`.mapWith(
        Number,
      ),
      cachedInputTokens: sql<number>`coalesce(sum((${messages.usage}->>'cachedInputTokens')::int), 0)`.mapWith(
        Number,
      ),
      outputTokens: sql<number>`coalesce(sum((${messages.usage}->>'outputTokens')::int), 0)`.mapWith(
        Number,
      ),
    })
    .from(messages)
    .where(sql`${messages.createdAt} >= now() - (${daysBack} || ' days')::interval`)
    .groupBy(sql`to_char(${messages.createdAt}, 'YYYY-MM-DD')`)
    .orderBy(sql`to_char(${messages.createdAt}, 'YYYY-MM-DD') desc`);
}
