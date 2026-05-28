# Database — Connection & Schema Guide

Postgres lives on Neon, provisioned through the Vercel-Neon integration on the `olander-agents` Vercel project. The app talks to it through Drizzle ORM. The schema is the standard Auth.js (next-auth) Drizzle adapter shape plus a `role` column on `user` for our tier model.

There is **one** Neon project. If you find a second one, something is wrong.

## Where it lives

- **Neon project:** `olander-agents` (id `<neon-project-id>`)
- **Neon org:** `Vercel: olanderagents-9868's projects` — managed by Vercel, do not detach
- **Region:** `aws-us-west-2` (Portland / pdx1, to sit next to the sfo1 Vercel functions and us-west-1 Qdrant)
- **Postgres version:** 17
- **Default branch:** `main` (find current id in Neon console)
- **Database:** `neondb`
- **Console:** https://console.neon.tech/app/projects/<neon-project-id>

The Neon project is owned by the Vercel integration. **Do not create a sibling Neon project under the standalone `Olander Agents` org** — that's how you end up with local dev pointing at one DB and prod at another (we've already done this dance once).

### Branches

- `main` — primary, what production hits.
- `<auto>-preview-<branch>-…` — Vercel auto-creates an ephemeral Neon branch off `main` for every preview deployment, so each PR gets isolated data. These are torn down with the deployment. You will not see any preview branches in the console until a Preview deploy fires.

## Connection paths

Different environments use different hosts on the same compute. **Both point at the same data**; pooling just changes the connection topology.

| Environment | Host | Why |
|---|---|---|
| Local dev (`.env.local`) | `<neon-host>…` (direct/unpooled) | Drizzle-kit DDL is happiest on a direct connection — pgBouncer's transaction-mode pooler can refuse some session-state operations |
| Vercel runtime (Production / Preview) | `<neon-host>…` (pooled) | Serverless functions burn through connection slots; pooling is mandatory at any real scale |
| Vercel preview branch | per-branch host, also pooled | Vercel injects a different `DATABASE_URL` per preview deploy |

The pooled host is just the unpooled host with `-pooler` inserted before the region segment. The `@neondatabase/serverless` driver (used in `src/db/index.ts`) talks over HTTP to Neon's proxy and is happy on either host.

Vercel sets `DATABASE_URL` plus a few aliases (`POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`, etc.) automatically on each deployment. Don't override them in the project's env settings unless you mean it.

## Schema

Defined in `src/db/schema.ts`. Core tables (the chat-persistence tables — `conversation`, `message`, `toolCall` — are also in `schema.ts`; see CLAUDE.md), all in the `public` schema:

| Table | Purpose |
|---|---|
| `user` | One row per signed-in human. `role` (`'admin' \| 'user' \| 'revoked'`) drives tier gating; it is *reconciled from* `member.role` on every login (see [Sign-in allowlist](#sign-in-allowlist)) — `member` is the source of truth. `dataScopes` mirrors `member.dataScopes` (also reconciled at login) and is what `/api/chat` reads from the session to gate P21 tool calls |
| `account` | OAuth provider linkage (Microsoft Entra today). Composite PK on `(provider, providerAccountId)` |
| `session` | DB-backed session tokens (we use the database session strategy, not JWT) |
| `verificationToken` | Magic-link / email verification tokens. Unused with Entra-only sign-in but the adapter requires the table |
| `member` | Sign-in allowlist: one row per email permitted to sign in, plus its tier. PK on `email` (lowercased). `addedBy` = the admin's `user.id` (null for migration-seeded/backfilled rows; not an FK on purpose). `dataScopes` (jsonb, nullable) is a per-member override of which P21 data buckets the chatbot may query for them — null means "use the tier default" (see `src/lib/scopes.ts`). Reads/writes via `src/lib/members.ts`; managed at `/admin/members`. See [Sign-in allowlist](#sign-in-allowlist) |

Two intentional design calls worth knowing:

- **`role` is `text`, not `pgEnum`.** Adding tiers is a code change with no DDL migration — adding `revoked` was exactly this (only the new `member` table needed a migration). `Role` is exported as a TS union from `schema.ts` for type-safety in app code.
- **`emailVerified` is left null for OAuth users.** Auth.js stamps that column only for the magic-link/email flow. Entra has already verified the user's email before issuing the OAuth token, so the null is expected. Don't write app code that gates on `if (user.emailVerified)`.

## Sign-in allowlist

Who may sign in is two gates, both required (see `src/auth.ts` `signIn` callback):

1. **Entra tenant (`tid`) check** — `AUTH_ALLOWED_TENANT_IDS`. The cryptographic boundary; `tid` is bound to Microsoft's per-tenant signing key. Empty ⇒ fails closed. Lives in `src/lib/auth-allowlist.ts` (kept pure for unit tests).
2. **Per-email membership** — a row in the `member` table whose `role` is not `revoked`, *or* the email is in `AUTH_BOOTSTRAP_ADMINS` (a comma-separated env var of always-allowed/always-admin emails — first-admin bootstrap + break-glass; see `.env.example`). Lives in `src/lib/members.ts`.

Tiers (`member.role`, mirrored onto `user.role`):

- `user` — normal access.
- `admin` — also sees `/admin/*` (audit, usage, members).
- `revoked` — blocked from everything: `signIn` denies them, and setting `revoked` (the "Remove user" button in `/admin/members`) immediately deletes their `session` rows so any live session ends now. Their `user` row, conversations, and tool-call audit history are kept. The row stays in the table but is hidden from `/admin/members` — re-add the email there to restore access (`addMember` upserts). `src/auth.ts` exports `activeSession()` (= `auth()` but returns null for `revoked`) which the chat pages/routes use as a backstop for the revoke-vs-session-delete race window.

`events.signIn` in `src/auth.ts` reconciles `user.role` **and** `user.dataScopes` from `member.role` / `member.dataScopes` on **every** login — the adapter creates a new `user` row with the schema default (`user`), so this is what actually applies an `admin` tier (or a per-member scope override) to someone an admin invited before they ever signed in, and it self-heals after any later change.

### Per-member data scopes (`dataScopes`)

The `member.dataScopes` column gates which P21 data the chatbot will let that user query — independent of the tier. Mirrored onto `user.dataScopes` at login; `/api/chat` reads it off the session, loads the live scope catalog via `loadScopeCatalog()`, and feeds both into `buildTools(scopes, catalog)` so the scope check fires before any P21 / Qdrant call.

- **Scope catalog lives in the database** in three editable tables (`scope`, `scope_view`, `scope_entity`) — see below. The base 10-bucket layout (`items`, `stock`, `customers`, `sales`, `invoices`, `pricing`, `traceability`, `inbound`, `outbound`, `purchasing`) is seeded by migration `0007` and mirrored in `src/lib/scope-defaults.ts`. Admins edit the catalog at `/admin/scopes` — drag a view between bucket columns, rename buckets inline, add new buckets, delete buckets (blocked if any member references them), or "Reset to defaults" to wipe and re-seed.
- **Admins bypass.** Tier `admin` is always treated as `"all"` — `dataScopes` on an admin row is informational only and only matters if they're later demoted.
- **null = "use tier default"** (the buckets flagged `defaultForUser: true` in the catalog). The default set is everything operational; `pricing` is the lone opt-in bucket.
- **Empty array (`[]`) = "no access"** — the user can sign in but every `viewsQuery`/`entityGet`/`searchCatalog` call returns `scope_denied`.
- **Uncategorized views are denied for non-admins.** A new P21 view that isn't mapped to any scope shows up under `/admin/scopes` → "Unassigned" and is rejected as `uncategorized_resource` until an admin places it. To ship a new default mapping, add it to `DEFAULT_VIEW_SCOPES` in `src/lib/scope-defaults.ts` and re-run the seed (or hit "Reset to defaults" in the UI).
- **Member assignment at `/admin/members`** — the "Data access" cell on each row opens a picker with checkboxes for the live catalog; saves through `setMemberScopesAction`. **Catalog editing at `/admin/scopes`** — drag-and-drop board reading the three tables and writing via server actions in `src/app/admin/scopes/actions.ts`. See `TESTING.md` § "When you change scope catalog state".

The `0002` migration creates `member`, backfills it from existing `user` rows (so nobody currently signed in is locked out by the switch from a domain allowlist), and seeds the project owners as bootstrap admins. Verify with `SELECT email, role FROM member ORDER BY "createdAt"`. The `0006` migration adds the `dataScopes` columns to `member` and `user` (both nullable, jsonb arrays of scope name strings).

### Scope catalog tables (`scope`, `scope_view`, `scope_entity`)

Added by migration `0007`. They make the bucketing **editable** so admins can rename, regroup, add, and delete buckets without code changes.

| Table | Notes |
| --- | --- |
| `scope` | One row per bucket. `key` is immutable (it's what `member.dataScopes` stores). `label` and `description` are what the admin UI shows. `defaultForUser` decides whether non-admin members get the bucket by default. `sortOrder` controls UI ordering. |
| `scope_view` | One row per `p21_view_*` mapped to a scope. PK on `viewName`, so a view lives in exactly one bucket; the drag-to-move action is an upsert. Views without a row here are uncategorized → denied for non-admins. |
| `scope_entity` | One row per entity-route rule. PK on (`area`, `resource`). Empty `resource` means "all routes under this area" (e.g. `inventory`/`""` → items); non-empty is an exact area+resource match (e.g. `entity`/`customers` → customers). |

The migration also rewrites any pre-existing `member.dataScopes` and `user.dataScopes` arrays to translate the legacy 7-bucket keys (`inventory`, `customers`, `sales`, `vendors`, `purchasing`, plus dropped `financials`/`hr_payroll`) into the new 10-bucket keys — so anyone with a per-member override at the time of the migration keeps the same effective access.

Verify the seed with `SELECT s.key, s.label, count(sv."viewName") FROM scope s LEFT JOIN scope_view sv ON sv."scopeId" = s.id GROUP BY s.key, s.label ORDER BY s."sortOrder"` — you should see 10 rows totaling 118 view mappings.

### The `neon_auth` schema (Vercel integration extra)

`neondb` also contains a `neon_auth` schema with its own `user`, `account`, `session`, `organization`, etc. tables. **We don't use it.** It's Neon's managed-auth product (Stack Auth under the hood), provisioned automatically by the Vercel integration. It's isolated in its own schema and harmless to ignore.

If you want it gone, disable Neon Auth in the Vercel project's integration settings. Not required.

## Migration workflow

The repo holds two related-but-different things:

- **`src/db/schema.ts`** — the spec: what the DB should look like.
- **`drizzle/0000_*.sql` + `drizzle/meta/`** — the history: versioned SQL that records how the DB got from empty to current.

We keep both because the spec answers "what shape is the DB?" and the history answers "how does a fresh environment reach that shape deterministically?" CI/CD, preview branches, and audit-trail concerns all need the history.

### To make a schema change

1. Edit `src/db/schema.ts`.
2. `npm run db:generate` — produces `drizzle/000N_<name>.sql` plus an updated snapshot in `drizzle/meta/`.
3. **Read the generated SQL.** Drizzle-kit occasionally guesses wrong (e.g., reads a column rename as drop+add and silently destroys data). If it's wrong, edit the SQL by hand or use `drizzle-kit generate --custom` for a stub.
4. `npm run db:migrate` — applies it to the DB pointed to by `DATABASE_URL`.
5. Commit `drizzle/` along with the schema.ts change in the same PR.

### To bring a fresh checkout up to date

```
npm install
cp .env.example .env.local   # then fill in values from 1Password / a teammate
npm run db:migrate           # applies any unapplied migrations
```

### Don't use `drizzle-kit push`

`push` skips the generate step and applies the diff directly. Tempting for fast iteration, but:

- No PR review of DDL.
- No deterministic replay across environments — two devs running push at different times can produce different SQL.
- Production deploys via CI need migration files, not push.

If you're prototyping a schema change locally and want to throw it away, push against a personal Neon dev branch. Never against `main`.

## Local dev setup

`.env.local` (gitignored) needs at minimum:

```
DATABASE_URL=postgresql://neondb_owner:<password>@<neon-host>.neon.tech/neondb?sslmode=require
```

Use the **direct** (non-`-pooler`) host for local — Drizzle-kit will be unhappy with the pooler for some DDL operations.

To get the password without copy-pasting from someone else:

- **Neon console:** https://console.neon.tech/app/projects/<neon-project-id> → Connection Details → reveal password.
- **Vercel CLI** (after `vercel link`): `vercel env pull .env.local` populates the file from Vercel's stored copy. Note this writes the *pooled* URL — swap in the direct host yourself, or override just the host portion.

> **Heads up on local data:** local dev currently writes against the same `main` branch that production reads from. This is fine while there's no real prod data, but the moment Olander users start signing in for real, you'll want a dedicated local dev branch (create one in the Neon console off `main`, point your `.env.local` at it). Note this and revisit before handoff.

## Operational notes

- **Claude Code MCP access.** The Neon MCP server is wired up (`neon-remote`). Claude can introspect schemas, run SQL, and create/delete branches without asking for the connection string. Useful for "verify my migration applied" or "show me the rows from last night's sign-in test."
- **Sign-in produces three rows.** A successful Entra sign-in writes one row each to `user`, `account`, and `session`. If you see fewer, the adapter wiring is broken — start from `src/auth.ts`.
- **Drizzle's own table.** `neondb.drizzle.__drizzle_migrations` tracks which migrations have been applied. Don't touch it manually unless you know what you're doing.
- **Auth.js requires the database session strategy** (configured in `src/auth.ts`) for the Drizzle adapter to populate the `session` table. JWT-strategy sessions skip the DB entirely — switching strategies would break our user-tier model unless the role is duplicated into the JWT.

## Quick reference

```bash
# Generate a new migration after editing schema.ts
npm run db:generate

# Apply pending migrations to whatever DATABASE_URL points at
npm run db:migrate

# Open Drizzle Studio (GUI for the DB pointed at by DATABASE_URL)
npm run db:studio

# Pull Vercel's stored env vars into .env.local (be careful with the pooled URL)
vercel env pull .env.local
```

Files to read for more depth:

- `src/db/schema.ts` — table definitions
- `src/db/index.ts` — Drizzle client setup (HTTP driver via `@neondatabase/serverless`)
- `src/auth.ts` — Auth.js config + Drizzle adapter wiring + `events.signIn` reconciler + `activeSession()`
- `src/lib/members.ts` — `member`-table reads/writes + the sign-in membership check
- `src/lib/auth-allowlist.ts` — pure tenant check + email normalization (unit-tested)
- `drizzle.config.ts` — drizzle-kit config (reads `.env.local`)
- `drizzle/0000_talented_invisible_woman.sql` — initial schema as applied SQL
