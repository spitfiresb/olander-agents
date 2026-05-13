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

// Catalog vectors live in Pinecone now, not Postgres — see RETRIEVAL.md
// § Vector store for the history (hit Neon Free's 512 MB at 36K rows; split
// stack moves the binding constraint off the shared app DB). The pgvector
// extension stays enabled on Neon (no-op cost) in case future smaller
// indexes want it back.

// Kept as text rather than pgEnum so adding tiers later is a no-op migration.
// Olander hasn't finalized access tiers yet (open question in README).
export type Role = "admin" | "user";

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

// --- Chat persistence (TODO §3) --------------------------------------------
// One row per chat. `deletedAt` is the soft-delete tombstone; reads filter on
// `deletedAt IS NULL`. Title is the first 60 chars of the first user message,
// editable later via PATCH.
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
  },
  (t) => [index("conv_user_updated_idx").on(t.userId, t.updatedAt)],
);

// One row per message. `parts` carries the full UIMessage parts array
// (text + tool-invocation + tool-result), so replay on reload looks
// identical to the original render. `model` and `usage` are nullable so
// historical rows from before we logged them stay valid.
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
    createdAt: timestamp("createdAt", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("msg_conv_created_idx").on(t.conversationId, t.createdAt)],
);

// Catalog row metadata — one row per inv_mast_uid mirroring p21_view_inv_mast.
// The actual vector lives in Pinecone (see src/lib/ai/pinecone.ts) keyed on
// the same inv_mast_uid. This table carries:
//   - `embed_input_hash`: dedupe key for backfill / sync. Same text ⇒ same
//     hash ⇒ no re-embed, no Pinecone re-upsert.
//   - the descriptive fields: source of truth for any callers that need the
//     full row without a Pinecone fetch (audit, exports, future joins).
// `embeddedAt` records when we last pushed this row's vector to Pinecone.
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
