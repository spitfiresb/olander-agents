# Database — Connection & Schema Guide

Postgres lives on Neon, provisioned through the Vercel-Neon integration on the `olander-agents` Vercel project. The app talks to it through Drizzle ORM. The schema is the standard Auth.js (next-auth) Drizzle adapter shape plus a `role` column on `user` for our tier model.

There is **one** Neon project. If you find a second one, something is wrong — see [History](#history) below.

## Where it lives

- **Neon project:** `olander-agents` (id `<neon-project-id>`)
- **Neon org:** `Vercel: olanderagents-9868's projects` — managed by Vercel, do not detach
- **Region:** `aws-us-east-1`
- **Postgres version:** 17
- **Default branch:** `main` (id `br-bold-rice-apsq5gqy`)
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

Defined in `src/db/schema.ts`. Four tables, all in the `public` schema:

| Table | Purpose |
|---|---|
| `user` | One row per signed-in human. Includes a `role` column (`'admin' \| 'user'`) for tier gating |
| `account` | OAuth provider linkage (Microsoft Entra today). Composite PK on `(provider, providerAccountId)` |
| `session` | DB-backed session tokens (we use the database session strategy, not JWT) |
| `verificationToken` | Magic-link / email verification tokens. Unused with Entra-only sign-in but the adapter requires the table |

Two intentional design calls worth knowing:

- **`role` is `text`, not `pgEnum`.** Adding new tiers later (e.g., `viewer`, `auditor`) becomes a code change with no DDL migration. `Role` is exported as a TS union from `schema.ts` for type-safety in app code.
- **`emailVerified` is left null for OAuth users.** Auth.js stamps that column only for the magic-link/email flow. Entra has already verified the user's email before issuing the OAuth token, so the null is expected. Don't write app code that gates on `if (user.emailVerified)`.

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
DATABASE_URL=postgresql://neondb_owner:<password>@<neon-host>.neon.tech/neondb?channel_binding=require&sslmode=require
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

## History

Date: 2026-05-09 to 2026-05-10.

The project initially had **two** Neon projects, which is why this doc keeps emphasizing one:

1. A standalone `Olander Agents` project in us-west-2 — created manually, was where local dev pointed and where the schema first landed.
2. The Vercel-managed `olander-agents` project in us-east-1 — created when the Vercel-Neon integration was installed.

Local dev had been writing schema (and would have written user data) into #1, while any deployed Vercel build would have hit #2 with no schema. We consolidated onto #2 by:

- Pointing `.env.local` at #2's direct host
- Generating and applying the initial Drizzle migration (`0000_talented_invisible_woman.sql`)
- Verifying end-to-end Entra sign-in landed rows in #2
- Deleting #1

The standalone `Olander Agents` Neon org still exists but is empty. Neon doesn't expose org deletion via API/MCP — clean it up from the console if it bothers you.

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
- `src/auth.ts` — Auth.js config + Drizzle adapter wiring
- `drizzle.config.ts` — drizzle-kit config (reads `.env.local`)
- `drizzle/0000_talented_invisible_woman.sql` — initial schema as applied SQL
