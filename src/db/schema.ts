import {
  pgTable,
  text,
  timestamp,
  integer,
  primaryKey,
  jsonb,
  index,
  boolean,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

// Catalog vectors live in Qdrant, not Postgres — see docs/Vector_Store.md.
// The pgvector extension stays enabled on Neon (no-op cost) in case future
// smaller indexes want it back.

// Kept as text rather than pgEnum so adding tiers is a no-op migration — adding
// `revoked` here required zero schema change (the new `member` table did need
// one). `revoked` = blocked from everything, but the user's row and chat
// history are kept; see src/lib/members.ts and the `member` table below.
export type Role = "admin" | "user" | "revoked";

export const users = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  image: text("image"),
  role: text("role").$type<Role>().notNull().default("user"),
});

export const accounts = pgTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [
    primaryKey({ columns: [account.provider, account.providerAccountId] }),
  ]
);

export const sessions = pgTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (vt) => [primaryKey({ columns: [vt.identifier, vt.token] })]
);

// Sign-in allowlist. One row per email that is permitted to sign in, plus the
// tier they get. This is the source of truth that the `signIn` callback checks
// (src/auth.ts) and that the rest of the app's `user.role` is reconciled from
// on every login. A `member` row is required to sign in *and* the Entra `tid`
// claim must match (see src/lib/auth-allowlist.ts). `email` is stored
// lowercased/trimmed. `addedBy` is the admin's user.id (null for rows
// backfilled or seeded by a migration); deliberately NOT a FK so removing an
// admin doesn't cascade-delete the audit of who added whom. Managed at
// /admin/members. See docs/db.md.
export const members = pgTable("member", {
  email: text("email").primaryKey(),
  role: text("role").$type<Role>().notNull().default("user"),
  addedBy: text("addedBy"),
  createdAt: timestamp("createdAt", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- Chat persistence (TODO §3) --------------------------------------------
// One row per chat. `deletedAt` is the soft-delete tombstone; reads filter on
// `deletedAt IS NULL`. Title is the first 60 chars of the first user message,
// editable later via PATCH. `pinnedAt` is null for unpinned chats; pinned
// chats sort by pinnedAt desc above the recency groups.
export const conversations = pgTable(
  "conversation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("Untitled chat"),
    createdAt: timestamp("createdAt", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deletedAt", { mode: "date", withTimezone: true }),
    pinnedAt: timestamp("pinnedAt", { mode: "date", withTimezone: true }),
  },
  (t) => [
    index("conv_user_updated_idx").on(t.userId, t.updatedAt),
    // Backs the pinned-first ordering in listConversations. The pinnedAt
    // column is nullable; NULLs sort to the end via the ORDER BY clause.
    index("conv_user_pinned_idx").on(t.userId, t.pinnedAt),
  ],
);

// One row per message. `parts` carries the full UIMessage parts array
// (text + tool-invocation + tool-result), so replay on reload looks
// identical to the original render. `model` and `usage` are nullable so
// historical rows from before we logged them stay valid.
//
// `searchText` is the flattened concatenation of text parts, populated at
// write time. The Postgres tsvector column (`searchVector`) is declared in
// the migration SQL as a STORED generated column over `searchText` plus a
// GIN index — it's queried via raw `sql` template literals from
// lib/conversations because drizzle doesn't model tsvector natively.
//
// `supersededAt` is the edit-and-resend tombstone: when a user edits an
// earlier message, every row at or after that message's createdAt is
// stamped with supersededAt = now() and disappears from user-facing reads
// (loadMessages, exportConversationMarkdown). Admin queries / audit logs
// see everything. Nullable; reads filter with `IS NULL`.
export const messages = pgTable(
  "message",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    conversationId: text("conversationId")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant" | "system">().notNull(),
    parts: jsonb("parts").notNull(),
    model: text("model"),
    usage: jsonb("usage"),
    searchText: text("searchText").notNull().default(""),
    createdAt: timestamp("createdAt", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    supersededAt: timestamp("supersededAt", { mode: "date", withTimezone: true }),
  },
  (t) => [
    index("msg_conv_created_idx").on(t.conversationId, t.createdAt),
    index("msg_conv_superseded_idx").on(t.conversationId, t.supersededAt),
  ],
);

// Catalog row metadata — one row per inv_mast_uid mirroring p21_view_inv_mast.
// The actual vector lives in Qdrant (see src/lib/ai/qdrant.ts) keyed on the
// same inv_mast_uid. This table carries:
//   - `embed_input_hash`: dedupe key for backfill / sync. Same text ⇒ same
//     hash ⇒ no re-embed, no Qdrant re-upsert.
//   - the descriptive fields: source of truth for any callers that need the
//     full row without a Qdrant fetch (audit, exports, future joins).
// `embeddedAt` records when we last pushed this row's vector to Qdrant.
export const catalogItem = pgTable("catalog_item", {
  invMastUid: integer("inv_mast_uid").primaryKey(),
  // NOT unique. Olander's P21 has duplicate item_ids across inv_mast_uids —
  // typically multi-company catalogs that mint internal SKU numbers per
  // company, which can collide across companies (real example: 597906
  // showed up in two different inv_mast_uids during the 2026-05-12
  // backfill). inv_mast_uid is the only stable unique key.
  itemId: text("item_id").notNull(),
  itemDesc: text("item_desc"),
  extendedDesc: text("extended_desc"),
  salesPricingUnit: text("sales_pricing_unit"),
  deleteFlag: boolean("delete_flag").notNull().default(false),
  sourceModifiedAt: timestamp("source_modified_at", {
    withTimezone: true,
    mode: "date",
  }),
  embedInputHash: text("embed_input_hash").notNull(),
  embeddedAt: timestamp("embedded_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

// Flattened audit log of tool calls — denormalized from messages.parts so
// /admin/audit can grep without loading every assistant message.
export const toolCalls = pgTable(
  "toolCall",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    messageId: text("messageId")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    conversationId: text("conversationId")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    toolName: text("toolName").notNull(),
    args: jsonb("args"),
    result: jsonb("result"),
    errorCode: text("errorCode"),
    durationMs: integer("durationMs"),
    createdAt: timestamp("createdAt", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("tool_call_created_idx").on(t.createdAt)],
);
