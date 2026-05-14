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

- **Connection topology, schema, migration workflow**: `docs/db.md`. Read before touching `src/db/`, `drizzle/`, or anything that talks to Postgres. Especially: there is exactly **one** Neon project (`<neon-project-id>`, Vercel-managed, `aws-us-west-2`) — do not create a second one.
- **Tables**: `src/db/schema.ts` carries the Auth.js adapter tables (`user`, `account`, `session`, `verificationToken`), the sign-in allowlist (`member` — who may sign in + their tier `admin`/`user`/`revoked` + per-member `dataScopes` override; reads/writes via `src/lib/members.ts`, managed at `/admin/members`), chat persistence (`conversation`, `message`, `toolCall`), and the catalog row metadata (`catalog_item` — text + dedupe hash, no vector column; the vectors live in Qdrant — see Vector store below). All chat-table reads/writes go through `src/lib/conversations.ts`, which enforces per-user ownership — never query the chat tables with an externally supplied id directly.

### Data-access scopes
- **What:** every P21 view and entity route is categorized into a named scope (`inventory`, `customers`, `sales`, `vendors`, `purchasing`, `financials`, `hr_payroll`) in `src/lib/scopes.ts`. Each member has an optional `dataScopes` override (null = tier default). Admins bypass entirely; default for non-admins is everything operational (inventory through purchasing) — `financials` and `hr_payroll` are opt-in. Uncategorized views are denied for non-admins by design.
- **Where it runs:** tools are built per-request in `/api/chat/route.ts` via `buildTools(scopes)`; `viewsQuery`, `entityGet`, and `searchCatalog` each run the scope check before any I/O. The deny-by-default also protects `searchCatalog` (it reads `p21_view_inv_mast` data — gated on the `inventory` scope).
- **When adding new P21 views:** add the matching `VIEW_RULES` entry in `src/lib/scopes.ts` in the same PR that introduces the view in `system-prompt.ts` or tool examples, or non-admin chat will reject it as `uncategorized_resource`. See `TESTING.md` § "When you change `src/lib/scopes.ts`".

### Vector store (Qdrant Cloud, AWS us-west-1)

- **Reference** (point shape, operations, payload schema, filter syntax, gotchas): `docs/Vector_Store.md` — read before writing any code that talks to Qdrant or touches `src/lib/ai/qdrant.ts`.
- **Why it lives outside Neon**: vector storage and user/chat-table storage have different growth curves; splitting them keeps Neon's scaling pressure on user-shaped data instead of a runaway catalog (or future doc-chunk) index eating the same disk.
- **Operations** (backfill, sync, smoke test, runbook): `docs/Retrieval_Runbook.md`.

### Tests
Run with `npm test`. Unit tests live in `src/**/__tests__/`. Keep test targets pure — `src/lib/auth-allowlist.ts` exists because `src/auth.ts` pulls in `next-auth`, which Vitest can't load without an environment shim.

## Product vision
Read `VISION.md` before making product decisions, adding features, or changing UX. Stability over features. Activation over new capabilities. No feature creep.

## Design

Refer to `DESIGN.md` before making design decisions.

## Regression prevention

Before declaring any change done, consult `TESTING.md` — a checklist of smoke tests and past regressions, sorted by historical fragility (auth → chat → status → P21 → db → ui). If your change touches a listed surface, run that section's checks. When a new class of regression bites us, add it to the file and promote the section.