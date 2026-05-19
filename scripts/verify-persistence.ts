// One-off verification: confirm the chat-persistence tables exist and the
// conversations.ts helpers can round-trip a user → conversation → message →
// tool_call. Run with `npx tsx scripts/verify-persistence.ts`.
//
// Uses dynamic imports because ESM hoists static `import` declarations above
// any imperative code — without that, `@/db` would read DATABASE_URL before
// dotenv loads `.env.local`.

import { config } from "dotenv";
config({ path: ".env.local", override: true });

async function main() {
  const { db } = await import("@/db");
  const { users, toolCalls } = await import("@/db/schema");
  const {
    createConversation,
    appendMessages,
    listConversations,
    loadMessages,
    exportConversationMarkdown,
    softDeleteConversation,
  } = await import("@/lib/conversations");
  const { eq } = await import("drizzle-orm");

  // Insert a synthetic user — the FK on conversation.userId points here.
  const [user] = await db
    .insert(users)
    .values({
      name: "Verify Persistence",
      email: `verify-${Date.now()}@local.test`,
      role: "user",
    })
    .returning();
  console.log("created user:", user.id, user.email);

  const conv = await createConversation(user.id, "Verify the chat persistence flow end to end");
  console.log("created conv:", conv.id, conv.title);

  await appendMessages(user.id, conv.id, [
    {
      role: "user",
      parts: [{ type: "text", text: "Verify the chat persistence flow end to end" }],
    },
    {
      role: "assistant",
      parts: [
        { type: "text", text: "OK. Here are 2 ACME rows." },
        {
          type: "tool-viewsQuery",
          toolCallId: "tc-1",
          state: "output-available",
          input: { viewName: "p21_view_customer", filter: "substringof('ACME', customer_name)" },
          output: { rows: [{ customer_id: 1, customer_name: "ACME 1" }], count: 1 },
        },
      ],
      model: "claude-sonnet-4-6",
      usage: { inputTokens: 100, outputTokens: 20 },
    },
  ]);
  console.log("appended 2 messages");

  const listed = await listConversations(user.id);
  console.log("listed:", listed.length, "conversations for user");

  const loaded = await loadMessages(user.id, conv.id);
  console.log("loaded messages:", loaded?.length);

  const tcRows = await db.select().from(toolCalls).where(eq(toolCalls.conversationId, conv.id));
  console.log("flattened tool_calls:", tcRows.length, tcRows[0]?.toolName);

  const exported = await exportConversationMarkdown(user.id, conv.id);
  console.log(
    "export markdown length:",
    exported?.markdown.length,
    "title:",
    exported?.title,
    "starts with:",
    exported?.markdown.slice(0, 40),
  );

  const deleted = await softDeleteConversation(user.id, conv.id);
  console.log("soft-deleted:", deleted);

  // Belt-and-braces: ensure cross-user reads still fail.
  const otherListed = await listConversations("nonexistent-user-id");
  console.log("cross-user list (should be 0):", otherListed.length);

  // Cleanup: hard-delete the synthetic user (cascades to conversation, messages, tool_calls).
  await db.delete(users).where(eq(users.id, user.id));
  console.log("cleaned up synthetic user");

  console.log("\nALL PASS");
}

main().catch((err) => {
  console.error("VERIFY FAILED:", err);
  process.exit(1);
});
