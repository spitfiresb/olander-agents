# Regression-prevention checklist

A pre-flight checklist for Claude (and humans) to run before declaring a change done. Sorted by **historical regression rate in this repo** — the top sections have actually broken before, so they get checked first.

## How to use this file

- Skim the section headings. If your change touches any of them, run that section's checks.
- "Smoke check" = the minimum 30-second test to prove the feature still works end-to-end.
- "Things that have actually broken" = past regressions in this repo. These are the mistakes most likely to recur.
- If a check is hard to run (e.g. requires production auth), say so explicitly rather than skipping silently.

Update this file when a new class of regression bites us. Promote sections up the list if they break again.

---

## 1. Auth (highest historical regression rate — 5 fix commits - can be skipped in dev, never in production builds)

**Surface:** `src/auth.ts`, `src/app/auth/error/`, `src/app/api/auth/[...nextauth]/`, `src/app/SignInPanel.tsx`.

**Why it tops the list:** Auth glues Microsoft Entra ID, env vars, a domain+tenant allowlist, and the Drizzle adapter together. Every one of those joints has caused a real regression.

### Smoke check
- [ ] Signed out, visit `/chat` → blocked / redirected to sign-in.
- [ ] Sign in with an allowlisted @olander.com or @uoregon.edu account → lands on `/chat`.
- [ ] Sign in with a non-allowed domain → lands on `/auth/error` with the branded page, not the default Auth.js page.
- [ ] Sign out from the account menu → signed-out surface, `/chat` is blocked again.
- [ ] Microsoft sign-in prompts the account picker every time (not silent SSO into a random cached account).

### Things that have actually broken
- **Wrong Entra env var name** (6d6c191) — using `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID` instead of `..._ISSUER`. Auth silently 500s. Verify all Entra env names match what `next-auth/providers/microsoft-entra-id` actually reads.
- **Email-suffix-only allowlist let a foreign tenant spoof @olander.com** (12ce16f) — `profile.email` is operator-settable. Always gate on `profile.tid` first, *then* domain.
- **`ALLOWED_TENANT_IDS` empty fails closed** (intentional, 12ce16f) — but that means an unset env var silently breaks all sign-ins. Confirm it's populated in every environment you deploy to.
- **Without `prompt: select_account`** (48c191f), MS silently reuses the browser's cached account and the user gets Access Denied with no way to switch.
- **Allowlist scoping mistakes** (6558955) — broadened from named emails to a whole domain by accident. Re-read `ALLOWED_DOMAINS` after any change to the signIn callback.

### When you change `src/auth.ts`
- [ ] Tenant ID check still runs **before** the domain check.
- [ ] Empty `ALLOWED_TENANT_IDS` still returns `false` (fail closed).
- [ ] `prompt: select_account` is still in the authorization params.
- [ ] `pages: { error: "/auth/error" }` is still wired so errors hit the branded page.
- [ ] `session.user.role = user.role` is still set in the session callback (consumers depend on it).

---

## 2. Chat (core product — 3 fix commits)

**Surface:** `src/app/api/chat/route.ts`, `src/app/chat/*`, `src/lib/ai/*`.

**Why high:** This *is* the product. If chat doesn't stream, nothing else matters.

### Smoke check
- [ ] Signed in, type a message into `/chat` composer and submit → assistant streams a reply.
- [ ] Submitting again while a stream is in flight is handled (Stop button works, or the second message queues sanely).
- [ ] The `inventorySearch` tool fires for a question like "do we have any M10 screws" → tool call + result render, model continues.
- [ ] Unauthenticated POST to `/api/chat` returns 401 (unless `ALLOW_UNAUTHED_DEV=1` in dev — confirm that bypass is *off* in production).
- [ ] Malformed body to `/api/chat` returns 400, not 500.

### Things that have actually broken
- **`convertToModelMessages` is async** (69eaddb) — must be `await`ed in the route. Without await, the model receives a Promise and errors mid-stream.
- **User message schema was too loose** (760db8a) — `parts: z.unknown()` let a client forge `tool-result` parts the model treated as authoritative. User-role parts must be **text-only** (`UserTextPart`). Don't relax this without server-persisted message state.
- **MessageList lint + body bg drift** (3554634) — style/lint regressions that slipped through. Run `npm run lint` before declaring done.

### When you change `src/app/api/chat/route.ts`
- [ ] `UserTextPart` still rejects non-text parts.
- [ ] `BodySchema` still bounds messages at `.max(50)`.
- [ ] `stepCountIs(8)` is still the stop condition (or higher — never unbounded).
- [ ] `auth()` gate is still in place; the only bypass is the dev `ALLOW_UNAUTHED_DEV` flag.
- [ ] Errors return JSON, not throw — frontend expects shaped error responses.

### When you change `src/lib/ai/tools.ts` or `system-prompt.ts`
- [ ] Smoke-test at least one tool-using prompt end-to-end. Tool-call regressions don't show up in lint.
- [ ] If you add a *mutating* tool, the loose `AssistantMessage.parts: z.unknown()` schema is no longer safe — revisit the comment in `route.ts`.

---

## 3. Status page (1 fix commit, security-class regression)

**Surface:** `src/app/api/status/route.ts`, `src/app/status/page.tsx`, droplet `proxy-server.mjs` and `install.sh`.

**Why mid-list:** Lower change frequency than auth/chat, but the one regression we had (435c0f2) was a data leak — unauthenticated `/api/status` was exposing internal IPs, hostnames, and check details. Re-leaks here are high-impact.

### Smoke check
- [ ] Visit `/status` while signed out → page renders, shows operational/degraded/down per service, **no internal IPs or hostnames anywhere in the HTML or `/api/status` JSON**.
- [ ] Each service shows a 90-day uptime bar that isn't entirely empty.
- [ ] P21 service reflects the droplet's actual health (force a failure on the droplet → status page shows it within the refresh window).
- [ ] Anthropic service falls back to `status.anthropic.com` if droplet payload lacks `anthropic` checks.

### Things that have actually broken
- **`/api/status` leaked check details to unauthenticated callers** (435c0f2) — exact IPs, hostnames, HTTP error bodies from internal hosts. Fix was symbolic labels only (`"egress IP mismatch"`, not the actual IP). Re-check after any edit to `buildP21Service`.

### When you change `src/app/api/status/route.ts`
- [ ] `buildP21Service` still emits **symbolic** failure labels, never `latest.checks.<x>.value` or `expected`.
- [ ] No env var values, droplet hostnames, or `DROPLET_HEALTH_URL` echoes leak into the response.
- [ ] `Cache-Control: no-store` is still set (status data must not be cached at the edge).
- [ ] `force-dynamic` export is preserved.

---

## 4. P21 / data path

**Surface:** `src/lib/ai/tools.ts` (`inventorySearch`), droplet `scripts/droplet/proxy-server.mjs`, `docs/P21_API.md`, `docs/P21_Connection.md`.

**Why:** Lower change frequency but high blast radius — if P21 calls break, the product can't answer real questions. Network path is fragile (the hosting provider whitelist, RFC1918 DNS override on the droplet).

### Smoke check
- [ ] Ask the chat a question that triggers `inventorySearch` → tool returns real P21 data, not a connection error.
- [ ] If you changed `proxy-server.mjs`, restart the droplet systemd service and re-run the smoke check above.
- [ ] Droplet health endpoint (`DROPLET_HEALTH_URL`) returns `p21_reachable.ok: true`.

### Things to watch for
- **the hosting provider IP allowlist** — the dev egress IP is `<proxy-ip>` (DO Reserved IP on droplet-1 / SFO2). If P21 starts rejecting, confirm the droplet is still routing via that IP.
- **RFC1918 DNS override** — P21's public DNS resolves to a private IP. The droplet's `/etc/hosts` overrides this with `<p21-host-ip>`. If you rebuild the droplet, the override has to be re-applied (see `install.sh`).
- **Proxy credentials** — `proxy-server.mjs` reads creds from env. Missing creds surface as `proxy_up.creds_present: false` in `/api/status`.

### When you change P21-touching code
- [ ] Re-read `docs/P21_API.md` (auth flow, OData operators, real response shapes) before writing new request code — the API has gotchas that aren't obvious from the response format.
- [ ] No P21 hostnames, internal IPs, or response bodies surface in user-facing errors.

---

## 5. Database / Drizzle

**Surface:** `src/db/`, `drizzle/`, `drizzle/meta/_journal.json`.

**Why low:** Stable so far, but a bad migration is hard to roll back on a shared Neon project.

### Smoke check
- [ ] `npm run db:generate` succeeds with no drift after schema edits.
- [ ] After a migration, sign-in still creates a user row and a session row (Auth.js adapter still wired).
- [ ] `drizzle/meta/_journal.json` is committed alongside the migration SQL file.

### Things to watch for
- **One Neon project only** (`<neon-project-id>`, Vercel-managed) — do *not* create a second project. See `docs/db.md`.
- **Schema drift** — if you edit `src/db/schema.ts` without running `db:generate`, the deployed DB diverges silently. Always generate + commit the migration.

---

## 6. UI / styling

**Surface:** `src/app/globals.css`, `src/app/**/*.tsx`, `src/components/*`.

**Why low:** UI bugs are visible and easy to spot, but they still ship. One color-scheme regression (e020bda) and one lint slip (3554634).

### Smoke check
- [ ] `/chat`, `/status`, and sign-in render with the canvas wash (`#FAF7F1`), not white-on-white or system dark mode.
- [ ] Wordmark renders as red box with white OLANDER — not a missing image, not the wrong red.
- [ ] `npm run lint` is clean.
- [ ] In a browser, the feature you changed actually works — type checks don't catch broken click handlers.

### Things to watch for
- **`color-scheme` must stay pinned to light** (e020bda) — the brand has no dark palette. Don't reintroduce `prefers-color-scheme: dark` overrides without a designed dark mode.
- **`DESIGN.md` rules** — one typeface (Geist), red reserved for primary action affordances, no emoji, no second accent. Re-read before adding visual elements.

---

## Quick-reference: pre-PR checklist

Before any PR, regardless of what you changed:

- [ ] `npm run lint` clean.
- [ ] `npm run build` clean (catches type errors that `lint` misses).
- [ ] Smoke-checked at least the section above that matches your change.
- [ ] If you changed auth, chat, or status — smoke-checked **all three**, because they share the session boundary.
- [ ] No secrets, IPs, or internal hostnames added to user-facing strings or error messages.
