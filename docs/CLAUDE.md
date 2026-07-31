# CLAUDE.md

<!-- BEGIN:nextjs-agent-rules -->
## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Critical references

### Data API (referred to as P21, Prophet 21, Epicor, Olander API)

- **API reference** (auth flow, tiers, endpoints, OData operators, real response shapes, gotchas): `P21_API.md` (withheld from the public copy — see `SANITIZATION.md`)
- **Reaching the API** (the hosting provider whitelist, RFC1918 DNS override, browser tunneling): `P21_Connection.md`
- **Droplet operations** (Caddy/TLS, install.sh, firewall, systemd, rebuild runbook): `Droplet.md`

### Database (Neon Postgres + Drizzle + Auth.js adapter)

- **Connection topology, schema, migration workflow**: `db.md`. Read before touching `src/db/`, `drizzle/`, or anything that talks to Postgres. Especially: there is exactly **one** Neon project (`<neon-project-id>`, Vercel-managed, `aws-us-west-2`) — do not create a second one.
- **Tables**: `src/db/schema.ts` carries the Auth.js adapter tables (`user`, `account`, `session`, `verificationToken`), the sign-in allowlist (`member` — who may sign in + their tier `admin`/`user`/`revoked` + per-member `dataScopes` override; reads/writes via `src/lib/members.ts`, managed at `/admin/members`), chat persistence (`conversation`, `message`, `toolCall`), the failed-turn diagnostic log (`chat_error` — one row per chat turn that errored or came back blank, written fail-safe by `src/lib/chat-errors.ts` and shown read-only at `/admin/errors`; see `Runbook.md` § diagnosing chat errors), and the catalog row metadata (`catalog_item` — text + dedupe hash, no vector column; the vectors live in Qdrant — see Vector store below). All chat-table reads/writes go through `src/lib/conversations.ts`, which enforces per-user ownership — never query the chat tables with an externally supplied id directly.

### Data-access scopes
- **What:** every P21 view and entity route is categorized into a named scope. The scope catalog (keys, labels, view assignments, entity assignments) is **data**, not code — it lives in the `scope`, `scope_view`, and `scope_entity` tables and is edited from `/admin/scopes` (a drag-and-drop kanban board). The 10-bucket base layout (`items`, `stock`, `customers`, `sales`, `invoices`, `pricing`, `traceability`, `inbound`, `outbound`, `purchasing`) ships in `src/lib/scope-defaults.ts` and is seeded by `drizzle/0008_*.sql`; the same defaults power the admin UI's "Reset to defaults". Each member has an optional `dataScopes` override (null = tier default). Admins bypass entirely; the default for non-admins is everything operational — `pricing` (margin-bearing job pricing) is the only opt-in bucket. Beyond the view-level gate, **cost/margin columns** (`*_cost`, `gross_margin`, `profit_percent`, COGS, commission cost, markups) are **redacted at the column level** for anyone without the `pricing` scope: they ride along on default-on views like `p21_view_inv_loc` / `p21_view_oe_hdr` / `p21_view_oe_line`, so view-level gating alone would leak them. The redaction (plus a schema-driven numeric re-coercion pass) lives in `src/lib/ai/p21-fields.ts` and is applied in `tools.ts` after the proxy returns. Selling-price tiers (`price1..price10`) are deliberately **not** redacted — reps need them to quote, and they appear on customer-facing invoices anyway. Uncategorized views are denied for non-admins by design.
- **Where it runs:** `/api/chat/route.ts` calls `loadScopeCatalog()` once at request entry and passes the snapshot into `buildTools(scopes, catalog)`; `viewsQuery`, `describeView`, `entityGet`, `searchCatalog`, and `aggregate` each run the scope check before any I/O. The deny-by-default also protects `searchCatalog` — it reads `p21_view_inv_mast` data, so it's gated on whatever scope that view currently lives in.
- **When adding new P21 views:** map the view to a scope at `/admin/scopes` (it'll appear under "Unassigned" after the next schema dump) **or** add it to `DEFAULT_VIEW_SCOPES` in `src/lib/scope-defaults.ts` and re-run the seed. Skipping this leaves the view as `uncategorized_resource` for non-admins. See `TESTING.md` § "When you change scope catalog state".

### Vector store (Qdrant Cloud, AWS us-west-1)

- **Reference** (point shape, operations, payload schema, filter syntax, gotchas): `Vector_Store.md` — read before writing any code that talks to Qdrant or touches `src/lib/ai/qdrant.ts`.
- **Why it lives outside Neon**: vector storage and user/chat-table storage have different growth curves; splitting them keeps Neon's scaling pressure on user-shaped data instead of a runaway catalog (or future doc-chunk) index eating the same disk.
- **Operations** (backfill, sync, smoke test, runbook): `Retrieval_Runbook.md`.

### Tests
Run with `npm test`. Unit tests live in `src/**/__tests__/`. Keep test targets pure — `src/lib/auth-allowlist.ts` exists because `src/auth.ts` pulls in `next-auth`, which Vitest can't load without an environment shim.

## Product vision
Read `VISION.md` before making product decisions, adding features, or changing UX. Stability over features. Activation over new capabilities. No feature creep.

## Design

Refer to `DESIGN.md` before making design decisions.

## Workforce-capture contract (pak)

Olander machines run **pak**, a workforce-capture daemon, which captures
AI prompts/responses from this app by reading its accessibility tree (config
lives in a separate internal repo, keyed to `<agent-domain>`). The following
surface details are a **compatibility contract** — changing any of them silently
breaks prompt capture fleet-wide with no error anywhere, so treat them like a
public API:

- The composer stays a plain `<textarea>` (`Composer.tsx`). Do not migrate to a
  contenteditable/custom editor without coordinating a pak config update.
- The stop button's `aria-label="Stop generating"`.
- The composer placeholder: "Ask about a customer, item, or order…".
- Assistant replies render inside the `prose-chat` container
  (`AssistantContent.tsx`).
- The URL rewrite to `/chat/<id>` for a new conversation is deferred until the
  turn settles (`ChatShell.tsx`, `pendingUrlConversationIdRef`) — a mid-submit
  URL change resets pak's pending capture and drops the first prompt of every
  new chat.

If one of these must change, update pak's site config in the same window
(`pak/helpers/prompt_tap.swift` + `pak/src/winprompt.rs`, site id
`<agent-domain>`) and note it in `pak/docs/AI_CAPTURE.md`.

## Regression prevention

Before declaring any change done, consult `TESTING.md` — a checklist of smoke tests and past regressions, sorted by historical fragility (auth → chat → status → P21 → db → ui). If your change touches a listed surface, run that section's checks. When a new class of regression bites us, add it to the file and promote the section.