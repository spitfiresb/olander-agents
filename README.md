# Olander Agents

Internal AI assistant for Olander's inside-sales team. Reps ask plain-English
questions about parts, customers, inventory, orders, and purchasing; the
assistant answers by querying Prophet 21 through a typed, read-only proxy.

See `docs/VISION.md` for the product framing and `docs/DESIGN.md` for the visual system.


## What this is, in 30 seconds

- **Frontend**: Next.js 16 App Router on Vercel. Streaming chat UI with
  markdown rendering, inline tool-call cards, and result tables.
- **Auth**: Microsoft Entra ID via Auth.js v5. Tenant-gated to Olander's
  directory; access is then per-email via a `member` allowlist managed in
  `/admin` (tiers: `user` / `admin` / `revoked`).
- **DB**: Neon Postgres (Vercel-managed). One project (`<neon-project-id>`).
  Tables: Auth.js adapter tables + `member` + `conversation`, `message`, `toolCall`.
- **LLM**: Anthropic Claude Sonnet 4.6 via `@ai-sdk/anthropic`. System prompt
  marked for ephemeral cache; tool calls run via the AI SDK tool loop.
- **P21 path**: Vercel → DigitalOcean droplet proxy (Reserved IP whitelisted
  by the hosting provider) → Prophet 21 REST. Two thin tools (`viewsQuery`, `entityGet`)
  cover almost every read pattern.

## Running locally

```bash
npm install
cp .env.example .env.local        # fill in the values below
npm run dev                       # http://localhost:3000
```

Required env vars in `.env.local`:

| Var | What |
|-----|------|
| `DATABASE_URL` | Pooled Neon connection string |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `AUTH_MICROSOFT_ENTRA_ID_ID` | App registration client id |
| `AUTH_MICROSOFT_ENTRA_ID_SECRET` | App registration client secret |
| `AUTH_MICROSOFT_ENTRA_ID_ISSUER` | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| `AUTH_ALLOWED_TENANT_IDS` | Comma-separated Entra tenant GUIDs (empty ⇒ no sign-ins) |
| `AUTH_BOOTSTRAP_ADMINS` | Comma-separated emails — always allowed, always admin (break-glass / first admin) |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `DROPLET_PROXY_URL` | `https://egress.<domain>` |
| `DROPLET_PROXY_TOKEN` | Shared bearer for the proxy |
| `DROPLET_HEALTH_URL`, `DROPLET_HEALTH_TOKEN` | For `/status` page |

Dev-only:

- `ALLOW_UNAUTHED_DEV=1` bypasses auth on `/api/chat`. Hard-guarded to
  `NODE_ENV=development` and `VERCEL_ENV != production`.

## Scripts

| Script | What |
|--------|------|
| `npm run dev` | Next dev server |
| `npm run build` | Production build |
| `npm start` | Serve production build |
| `npm run lint` | ESLint |
| `npm test` | Run Vitest unit tests once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run db:generate` | Generate a Drizzle migration |
| `npm run db:migrate` | Apply migrations against `DATABASE_URL` |
| `npm run db:studio` | Open Drizzle Studio |

## Who can sign in

Two gates, **both must pass** (`src/auth.ts` `signIn`):

1. **Entra tenant** — the token's `tid` must be in `AUTH_ALLOWED_TENANT_IDS`
   (`src/lib/auth-allowlist.ts`). Runs first; empty fails closed (no sign-ins).
2. **Per-email** — a non-`revoked` row in the `member` table, *or* the email is
   in `AUTH_BOOTSTRAP_ADMINS` (`src/lib/members.ts`). Members are managed at
   `/admin/members`; tiers are `user` / `admin` / `revoked`. `user.role` is
   reconciled from `member.role` on every login. See `docs/db.md` →
   "Sign-in allowlist" and `docs/Runbook.md` → "Managing who can sign in".

## Where prod lives

- App: Vercel — project `<owner>/olander-agents-app`.
- DB: Neon project `<neon-project-id>`, Vercel-managed.
- P21 proxy: DigitalOcean droplet `droplet-1` (SFO2). Reserved IP
  `<proxy-ip>`. Caddy fronts Node at port 8089. systemd units in
  `scripts/droplet/`.

See `docs/Runbook.md` for who-to-call when something is broken.

## Documentation index

All documentation lives in [`docs/`](docs/).

**Product & process**
- `docs/VISION.md` — product framing
- `docs/DESIGN.md` — design system
- `docs/TESTING.md` — regression checklist
- `docs/OLANDER_REQUESTS.md` — client request tracker
- `docs/CLAUDE.md` — working rules for AI coding agents

**Operations**
- `docs/Runbook.md` — deploy / rollback / on-call
- `docs/Droplet.md` — droplet operations
- `docs/db.md` — Neon + Drizzle
- `docs/Limitations.md` — known limits
- `docs/Assignments.md` — ownership

**P21 integration**
- `docs/P21_API.md` — upstream API reference
- `docs/P21_Connection.md` — network plumbing
- `docs/P21_Schema.md` — view and column reference

**Retrieval**
- `docs/RETRIEVAL.md` — retrieval design and cost analysis
- `docs/Vector_Store.md` — Qdrant wire contract
- `docs/Retrieval_Runbook.md` — backfill, sync, recovery

**Architecture & history**
- `docs/System.md` — system diagram
- `docs/plans/` — archived planning snapshots (older than the codebase)
