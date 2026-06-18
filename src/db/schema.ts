import {
  pgTable,
  text,
  timestamp,
  integer,
  primaryKey,
  jsonb,
  index,
  boolean,
  serial,
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
  // Per-user override of data scopes (P21 view buckets the chatbot may query).
  // null = "use the tier default" (the set of scopes flagged defaultForUser in
  // src/lib/scopes.ts). Mirrored from `member.dataScopes` on every login by
  // events.signIn in src/auth.ts. Admins bypass scope checks entirely.
  dataScopes: jsonb("dataScopes").$type<string[] | null>(),
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
  // Per-member override of data scopes. null = "use the tier default". An
  // explicit empty array means "no data scopes" (the member can sign in but
  // every P21 view/entity call is denied). Admin tier bypasses regardless.
  // See src/lib/scopes.ts for the scope catalog and the view→scope rules.
  dataScopes: jsonb("dataScopes").$type<string[] | null>(),
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

// TEMPORARY trial spend gate. A single-row ("singleton") table holding the
// deployment-wide trial budget. /api/chat hard-stops for EVERYONE — admins
// included — once estimated spend (priced per-model from message usage) crosses
// `limit_cents`. The budget is provisioned out-of-band: the app only reads this
// row (no in-app control to raise the limit or flip `enabled` off), so it's
// seeded/edited directly in the DB. `/admin` shows it read-only.
//
// Built to be ripped out when the client moves to real billing. To remove the
// whole feature: drop this table, delete src/lib/trial.ts, remove the
// TrialUsageSummary on /admin, the TrialBanner usage in ChatShell, and the gate
// block in the chat route. The migration seeds the singleton row (id =
// 'singleton', $10, enabled).
export const trialBudget = pgTable("trial_budget", {
  id: text("id").primaryKey().default("singleton"),
  enabled: boolean("enabled").notNull().default(true),
  limitCents: integer("limit_cents").notNull().default(1000),
  updatedAt: timestamp("updatedAt", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedBy: text("updatedBy"),
});

// Single-row ("singleton") table holding the admin-configurable max upload
// size, in whole megabytes. Unlike trial_budget there IS an in-app control:
// /admin/uploads writes `max_file_mb` here (clamped to the bounds in
// src/lib/upload-settings.ts). Reads fail-open to the default if the row is
// missing, so the feature works before the seed lands and never takes uploads
// down on a DB hiccup. The hard ceiling lives in code
// (MAX_UPLOAD_CEILING_BYTES in src/lib/blob.ts) — this value can't exceed it.
export const uploadSettings = pgTable("upload_settings", {
  id: text("id").primaryKey().default("singleton"),
  maxFileMb: integer("max_file_mb").notNull().default(25),
  updatedAt: timestamp("updatedAt", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedBy: text("updatedBy"),
});

// Reference documents the chatbot can retrieve from (RAG). One row per uploaded
// document; the actual chunk vectors live in Qdrant's `olander-docs` collection
// (see src/lib/ai/qdrant-docs.ts), keyed by this row's `id` in the chunk
// payload's `document_id`. The original file lives in Vercel Blob at `blobUrl`.
// `status` tracks ingestion: 'processing' (uploaded, embedding in progress) →
// 'ready' (searchable) or 'failed' (see `error`); a 'ready' row may also carry
// a non-blocking note in `error` (e.g. a likely-scanned PDF). Managed at
// /admin/documents.
// Deliberately mirrors the catalog split: row metadata in Neon, vectors in
// Qdrant, original bytes in Blob.
export const referenceDocuments = pgTable(
  "reference_document",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    filename: text("filename").notNull(),
    mediaType: text("mediaType").notNull(),
    sizeBytes: integer("sizeBytes").notNull(),
    blobUrl: text("blobUrl").notNull(),
    blobPathname: text("blobPathname").notNull(),
    status: text("status")
      .$type<"processing" | "ready" | "failed">()
      .notNull()
      .default("processing"),
    chunkCount: integer("chunkCount").notNull().default(0),
    // Human-readable note for the row's current state. On 'failed' it's the
    // failure reason (shown red); on 'ready' it's an optional non-blocking
    // caveat such as a likely-scanned PDF (shown amber). A row is only ever in
    // one of those states, so a single field serves both. Null when clean.
    error: text("error"),
    uploadedBy: text("uploadedBy"),
    createdAt: timestamp("createdAt", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("reference_document_created_idx").on(t.createdAt)],
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

// --- Data-access scopes ----------------------------------------------------
// Three tables hold the editable scope catalog the admin UI manages at
// /admin/scopes. They replace the hardcoded tables that used to live in
// src/lib/scopes.ts. Stored as data so admins can rename, regroup, add, and
// delete scopes without code changes. The seed in drizzle/0008_*.sql lays
// down a 10-scope base layout grounded in the live P21 schema dump; the same
// defaults live in src/lib/scope-defaults.ts so the admin UI's "Reset to
// defaults" can rebuild them.
//
// `key` is immutable and is what member.dataScopes stores (so renaming the
// human-facing label is free, but the key never changes). `label` and
// `description` are what the admin UI shows. `defaultForUser` decides
// whether the scope is granted to a non-admin member who has no per-member
// dataScopes override. `sortOrder` controls UI ordering.
export const scopes = pgTable("scope", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  label: text("label").notNull(),
  description: text("description").notNull().default(""),
  defaultForUser: boolean("defaultForUser").notNull().default(false),
  sortOrder: integer("sortOrder").notNull().default(0),
  createdAt: timestamp("createdAt", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
});

// One row per P21 view, mapping it to exactly one scope. Views with no row
// here are uncategorized → denied for non-admins (deny-by-default).
export const scopeViews = pgTable(
  "scope_view",
  {
    viewName: text("viewName").primaryKey(),
    scopeId: integer("scopeId")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
  },
  (t) => [index("scope_view_scope_idx").on(t.scopeId)],
);

// Entity REST routes (/api/<area>/<resource>/...). An empty `resource`
// means "all routes under this area"; non-empty matches the area+resource
// prefix exactly. See scopeForEntity in src/lib/scopes.ts.
export const scopeEntities = pgTable(
  "scope_entity",
  {
    area: text("area").notNull(),
    resource: text("resource").notNull().default(""),
    scopeId: integer("scopeId")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.area, t.resource] }),
    index("scope_entity_scope_idx").on(t.scopeId),
  ],
);

// Diagnostic log of FAILED chat turns — one row per turn that errored or came
// back blank. The product surfaces only a friendly code to the user ("Something
// went wrong. Please try again."); this table keeps the RAW provider error +
// the query that triggered it so admins can see *which* question hit *what*
// error and when (the evidence the status page can't give — that's infra-level,
// this is per-request). Read-only at /admin/errors.
//
// `userId`/`conversationId` are nullable plain text with NO foreign key on
// purpose: an error can fire before a conversation row exists (or in dev-bypass
// with no user), and the evidence must outlive a later user/conversation delete
// — diagnostics shouldn't cascade away. Raw error text is stored in full (it's
// admin-only and server-side, the same trust level as the existing
// `console.error` logging); the client never sees these columns. The write path
// (`logChatError` in src/lib/chat-errors.ts) is fail-safe — it swallows its own
// errors so logging can never compound the failure it records.
export const chatErrors = pgTable(
  "chat_error",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    createdAt: timestamp("createdAt", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    userId: text("userId"),
    conversationId: text("conversationId"),
    // Where in the request lifecycle it failed: 'setup' (before streaming —
    // e.g. model init), 'stream' (the main agent loop errored), 'recovery' (the
    // blank-answer recovery pass errored), 'blank_answer' (loop + recovery both
    // finished clean but produced no visible text — a soft failure, not a throw).
    phase: text("phase").notNull(),
    // The friendly code the user's composer mapped to (stream_error,
    // provider_unavailable, provider_quota, …). 'stream_error' is the generic
    // "Something went wrong" the CEO reported.
    code: text("code"),
    httpStatus: integer("httpStatus"),
    errorName: text("errorName"),
    errorMessage: text("errorMessage"),
    errorStack: text("errorStack"),
    provider: text("provider"),
    model: text("model"),
    // The user's last message text (truncated). Copied from the turn rather than
    // joined from `message` because an errored turn may never have been
    // persisted — the row must stand alone for diagnosis.
    query: text("query"),
    // How many tool calls completed before the failure — separates "died
    // immediately" from "ran 4 ERP searches, then stalled".
    toolCallCount: integer("toolCallCount"),
    finishReason: text("finishReason"),
  },
  (t) => [index("chat_error_created_idx").on(t.createdAt)],
);

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
