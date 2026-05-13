# CLAUDE.md

<!-- BEGIN:nextjs-agent-rules -->
## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Critical references

### Data API (referred to as P21, Prophet 21, Epicor, Olander API)

- **API reference** (auth flow, tiers, endpoints, OData operators, real response shapes, gotchas): `docs/P21_API.md` — read before writing any code that calls P21
- **Reaching the API** (the hosting provider whitelist, RFC1918 DNS override, browser tunneling): `docs/P21_Connection.md`
- **Droplet operations** (Caddy/TLS, install.sh, firewall, systemd, rebuild runbook): `docs/Droplet.md`

### Database (Neon Postgres + Drizzle + Auth.js adapter)

- **Connection topology, schema, migration workflow, history of the Vercel-Neon consolidation**: `docs/db.md`. Read before touching `src/db/`, `drizzle/`, or anything that talks to Postgres. Especially: there is exactly **one** Neon project (`<neon-project-id>`, Vercel-managed) — do not create a second one.
- **Tables**: `src/db/schema.ts` carries the Auth.js adapter tables (`user`, `account`, `session`, `verificationToken`), the sign-in allowlist (`member` — who may sign in + their tier `admin`/`user`/`revoked`; reads/writes via `src/lib/members.ts`, managed at `/admin/members`), plus chat persistence (`conversation`, `message`, `toolCall`). All chat-table reads/writes go through `src/lib/conversations.ts`, which enforces per-user ownership — never query the chat tables with an externally supplied id directly.

### Tests
Run with `npm test`. Unit tests live in `src/**/__tests__/`. Keep test targets pure — `src/lib/auth-allowlist.ts` exists because `src/auth.ts` pulls in `next-auth`, which Vitest can't load without an environment shim.

## Product vision
Read `VISION.md` before making product decisions, adding features, or changing UX. Stability over features. Activation over new capabilities. No feature creep.

## Design

Refer to `DESIGN.md` before making design decisions.

## Regression prevention

Before declaring any change done, consult `TESTING.md` — a checklist of smoke tests and past regressions, sorted by historical fragility (auth → chat → status → P21 → db → ui). If your change touches a listed surface, run that section's checks. When a new class of regression bites us, add it to the file and promote the section.