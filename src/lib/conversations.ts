import { and, desc, eq, gte, ilike, isNull, or, sql } from "drizzle-orm";
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

// Correlated subquery used by both list+search to fetch each conversation's
// first user-message text as a snippet for the empty-state recent-chat cards
// (Stage 4b). LEFT(..., 220) caps bandwidth — CSS line-clamp truncates the
// visible portion; 220 is just a buffer so the clamp boundary always lands
// before the DB cap. Filters supersededAt IS NULL so edit-and-resend doesn't
// resurrect a dropped first message into the card.
const firstUserSnippetSql = sql<string | null>`(
  SELECT LEFT(m."searchText", 220)
  FROM ${messages} m
  WHERE m."conversationId" = ${conversations.id}
    AND m."role" = 'user'
    AND m."supersededAt" IS NULL
  ORDER BY m."createdAt" ASC
  LIMIT 1
)`;

export async function listConversations(userId: string) {
  return db
    .select({
      id: conversations.id,
      title: conversations.title,
      updatedAt: conversations.updatedAt,
      pinnedAt: conversations.pinnedAt,
      snippet: firstUserSnippetSql,
    })
    .from(conversations)
    .where(and(eq(conversations.userId, userId), isNull(conversations.deletedAt)))
    .orderBy(
      // Pinned rows surface first (newest pin on top), then everything else
      // by recency. NULLS LAST keeps unpinned rows below the pinned group.
      sql`${conversations.pinnedAt} desc nulls last`,
      desc(conversations.updatedAt),
    );
}

// Title ILIKE + full-text on message bodies. Returns conversation summaries
// ordered pinned-first, then by FTS rank descending, then by recency. Always
// filters by userId — pass the calling user's id, never one from the body.
export async function searchConversations(userId: string, query: string) {
  const trimmed = query.trim();
  if (!trimmed) return listConversations(userId);

  // plainto_tsquery is the right fit for a search box: punctuation-tolerant,
  // ANDs the words together, no operator surface for users to fight with.
  // ts_rank_cd ranks rows that match more terms / shorter texts higher.
  const titlePattern = `%${trimmed.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

  return db
    .select({
      id: conversations.id,
      title: conversations.title,
      updatedAt: conversations.updatedAt,
      pinnedAt: conversations.pinnedAt,
      snippet: firstUserSnippetSql,
      rank: sql<number>`
        coalesce(
          max(ts_rank_cd(${messages}."searchVector", plainto_tsquery('english', ${trimmed}))),
          0
        )
      `.mapWith(Number),
    })
    .from(conversations)
    .leftJoin(messages, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.userId, userId),
        isNull(conversations.deletedAt),
        or(
          ilike(conversations.title, titlePattern),
          // Match a message body only when the message is still live —
          // superseded turns shouldn't surface a conversation, otherwise the
          // rep clicks a result and the matching content isn't visible.
          and(
            sql`${messages}."searchVector" @@ plainto_tsquery('english', ${trimmed})`,
            isNull(messages.supersededAt),
          ),
        ),
      ),
    )
    .groupBy(
      conversations.id,
      conversations.title,
      conversations.updatedAt,
      conversations.pinnedAt,
    )
    .orderBy(
      sql`${conversations.pinnedAt} desc nulls last`,
      sql`rank desc`,
      desc(conversations.updatedAt),
    )
    .limit(50);
}

export async function setPinned(
  userId: string,
  conversationId: string,
  pinned: boolean,
) {
  const result = await db
    .update(conversations)
    .set({ pinnedAt: pinned ? new Date() : null })
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
    .where(
      and(
        eq(messages.conversationId, conversationId),
        // Edit-and-resend: superseded rows stay in the DB for audit but
        // disappear from user-facing replay. Admin queries can drop this
        // filter to see the full history.
        isNull(messages.supersededAt),
      ),
    )
    .orderBy(messages.createdAt);
  return rows;
}

// Edit-and-resend tombstone. Sets supersededAt = now() on every message in
// `conversationId` whose createdAt is >= the target message's createdAt.
// Ownership-gated by getConversation; bails silently if the target isn't on
// this conversation (forged id or stale client cache pointing at a deleted
// chat). Already-superseded rows are skipped so their original timestamp is
// preserved for forensics. Returns the count of newly-superseded rows.
export async function supersedeMessagesFrom(
  userId: string,
  conversationId: string,
  fromMessageId: string,
): Promise<number> {
  const conv = await getConversation(userId, conversationId);
  if (!conv) return 0;

  const [target] = await db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.id, fromMessageId),
        eq(messages.conversationId, conversationId),
      ),
    )
    .limit(1);
  if (!target) return 0;

  const result = await db
    .update(messages)
    .set({ supersededAt: new Date() })
    .where(
      and(
        eq(messages.conversationId, conversationId),
        gte(messages.createdAt, target.createdAt),
        isNull(messages.supersededAt),
      ),
    )
    .returning({ id: messages.id });
  return result.length;
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
  // When the caller (chat route) has a stable id for this message — typically
  // the AI SDK's client-generated id — passing it through here keeps the DB
  // row's id aligned with what the client tracks, so edit-and-resend's
  // editedMessageId lookup works on freshly-sent turns. Omit to let drizzle's
  // $defaultFn assign a UUID.
  id?: string;
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
        // Spread id only when the caller provided one; otherwise drizzle's
        // schema-level $defaultFn(crypto.randomUUID) supplies a UUID. Mixing
        // formats in one column is fine — text column accepts any string.
        ...(m.id ? { id: m.id } : {}),
        conversationId,
        role: m.role,
        parts: m.parts as object,
        model: m.model ?? null,
        usage: (m.usage ?? null) as object | null,
        searchText: extractSearchText(m.parts),
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

// Flattens text parts from a UIMessage.parts array into a single string the
// Postgres tsvector column can index. Mirrors the backfill SQL in
// migration 0002 — keep the two in sync if the part shape ever changes.
export function extractSearchText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const out: string[] = [];
  for (const p of parts) {
    if (
      typeof p === "object" &&
      p !== null &&
      "type" in p &&
      (p as { type: unknown }).type === "text" &&
      "text" in p &&
      typeof (p as { text: unknown }).text === "string"
    ) {
      const t = (p as { text: string }).text.trim();
      if (t) out.push(t);
    }
  }
  return out.join(" ");
}

export async function exportConversationMarkdown(
  userId: string,
  conversationId: string,
): Promise<{ markdown: string; title: string } | null> {
  const conv = await getConversation(userId, conversationId);
  if (!conv) return null;
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        // Match what the rep sees on reload — exclude superseded edit-and-
        // resend rows. Admin audit reads should drop this filter.
        isNull(messages.supersededAt),
      ),
    )
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
  return { markdown: lines.join("\n"), title: conv.title };
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
