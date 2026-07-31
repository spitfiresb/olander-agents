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

**Surface:** `src/auth.ts`, `src/lib/auth-allowlist.ts`, `src/lib/members.ts`, `src/app/admin/members/`, `src/app/auth/error/`, `src/app/api/auth/[...nextauth]/`, `src/app/SignInPanel.tsx`.

**Why it tops the list:** Auth glues Microsoft Entra ID, env vars, the tenant check + the `member` allowlist, and the Drizzle adapter together. Every one of those joints has caused a real regression.

### Smoke check
- [ ] Signed out, visit `/chat` → blocked / redirected to sign-in.
- [ ] Sign in with an account that has a non-`revoked` `member` row (or is in `AUTH_BOOTSTRAP_ADMINS`) → lands on `/chat`.
- [ ] Sign in with an account that is **not** in `member` and not a bootstrap admin → lands on `/auth/error` with the branded page, not the default Auth.js page.
- [ ] Sign out from the account menu → signed-out surface, `/chat` is blocked again.
- [ ] Microsoft sign-in prompts the account picker every time (not silent SSO into a random cached account).
- [ ] As an admin, `/admin/members`: add an email → it appears; flip a `User`/`Admin` toggle → "Save changes" turns red, click it → tier persists; "Remove user" → that user's `session` rows are gone, they're bounced to `/auth/error`, and the row disappears; re-add the same email → they're back and can sign in again. `AUTH_BOOTSTRAP_ADMINS` accounts work even with an empty `member` table. (`/api/dev/sign-in` bypasses the `signIn` gate + `events.signIn` — it exercises the admin actions and session-killing, not the gate; the gate is covered by `npm test`.)

### Things that have actually broken
- **Wrong Entra env var name** (6d6c191) — using `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID` instead of `..._ISSUER`. Auth silently 500s. Verify all Entra env names match what `next-auth/providers/microsoft-entra-id` actually reads.
- **Email-suffix-only allowlist let a foreign tenant spoof @olander.com** (12ce16f) — `profile.email` is operator-settable. Always gate on `profile.tid` first, *then* the email check. (`evaluateTenant` now deliberately does **not** check the email domain — the `member`-table membership check is the email gate. Don't re-add a domain assertion thinking it's a regression.)
- **`AUTH_ALLOWED_TENANT_IDS` empty fails closed** (intentional, 12ce16f) — but that means an unset env var silently breaks all sign-ins. Confirm it's populated in every environment you deploy to.
- **Without `prompt: select_account`** (48c191f), MS silently reuses the browser's cached account and the user gets Access Denied with no way to switch.
- **Domain → per-email allowlist migration** — the `0002` migration backfills `member` from existing `user` rows + seeds bootstrap admins; an empty `member` table on a fresh deploy locks everyone out except `AUTH_BOOTSTRAP_ADMINS`.

### When you change `src/auth.ts`
- [ ] Tenant ID check (`evaluateTenant`) still runs **before** the `isAllowedMember` membership check.
- [ ] Empty `AUTH_ALLOWED_TENANT_IDS` still makes `evaluateTenant` return `{ ok: false }` (fail closed).
- [ ] `events.signIn` still reconciles `user.role` from `member.role` (otherwise an invited-as-admin user stays a plain user after their first login).
- [ ] `prompt: select_account` is still in the authorization params.
- [ ] `pages: { error: "/auth/error" }` is still wired so errors hit the branded page.
- [ ] `session.user.role = user.role` is still set in the session callback (consumers depend on it).
- [ ] `activeSession()` still returns `null` for `revoked`; chat pages/routes use it (not bare `auth()`).

### When you change `/admin/members` or `src/lib/members.ts`
- [ ] Actions still re-check `role === "admin"` server-side (the disabled UI controls are not the gate).
- [ ] You still can't change your **own** tier or remove yourself, and a batch that would leave **zero** admins is rejected.
- [ ] "Remove user" still goes through `setMemberRole(email, "revoked")` — deletes that user's `session` rows and sets `user.role = "revoked"`; the row stays but `listMembers` (which filters out `revoked`) hides it; re-adding the email restores it.
- [ ] `npm test` covers `normalizeEmail` / `parseBootstrapAdmins` / `evaluateTenant` (the DB-touching `members.ts` isn't unit-tested by design — same reason `auth-allowlist.ts` is split out).

### When you change scope catalog state
**Surface:** `src/lib/scopes.ts`, `src/lib/scope-defaults.ts`, `src/lib/ai/tools.ts` (`buildTools`), `src/app/api/chat/route.ts`, `src/app/admin/scopes/*`, `src/app/admin/members/ScopePickerDialog.tsx`, the `scope` / `scope_view` / `scope_entity` tables, `member.dataScopes` + `user.dataScopes` columns.

- [ ] Admin tier still bypasses (`effectiveScopes("admin", _, catalog) === "all"`); admins keep `viewsQuery`/`entityGet` on every view regardless of how the catalog is shaped.
- [ ] Default non-admin scopes still cover everything operational and exclude `pricing` (margin-bearing job pricing is the one opt-in bucket). The point is that signing in as a normal user does **not** expose customer-specific contract margins without an admin opt-in.
- [ ] Deny-by-default for uncategorized views — a fresh `p21_view_*` that no scope owns is denied for non-admins. When you add a new view to `system-prompt.ts` or tool examples, either map it via `/admin/scopes` or add it to `DEFAULT_VIEW_SCOPES` in `scope-defaults.ts` in the same PR.
- [ ] After re-running `scripts/droplet/dump-p21-schema.sh` (or `scripts/build-p21-catalog.mjs`), diff the new view list against the seed in `scope-defaults.ts` and confirm nothing sensitive lands in a low-sensitivity bucket. New compounds that nobody mapped surface in `/admin/scopes` → "Unassigned" → denied, which is the signal to triage and explicitly categorize.
- [ ] `/admin/scopes` page loads cleanly as an admin; bucket cards collapse by default and `localStorage` (`olander.scopes.expanded`) persists which were expanded; chevron toggles expand state per column; drag-and-drop into a collapsed bucket header works (the column header stays an active drop zone); search auto-expands columns with matches.
- [ ] Creating, renaming (inline), moving views (drag or ⋮ menu), deleting a scope all work; delete is blocked when a member references the bucket and shows a clear error.
- [ ] "Reset to defaults" wipes and re-seeds: ten buckets reappear, all 118 views map back to the documented buckets, member overrides with surviving keys still work.
- [ ] `searchCatalog` still gates on whatever scope owns `p21_view_inv_mast` (defaults to `items`) — bypassing the gate via the semantic-search path is the obvious hole.
- [ ] `events.signIn` in `src/auth.ts` still mirrors `member.dataScopes` onto `user.dataScopes` on every login (otherwise per-member overrides only land after the user signs in *again*).
- [ ] `session.user.dataScopes` is still surfaced in the session callback — `/api/chat` reads it directly without a second DB hit.
- [ ] `setMemberScopesAction` still re-checks `requireAdmin()` server-side; the new actions in `src/app/admin/scopes/actions.ts` (create / update / delete / move / reset) all do the same.
- [ ] `npm test` covers `scopes.ts` (bucketing against `scope-defaults.ts`, default user, admin bypass, uncategorized denial, sanitize, catalog hygiene).

---

## 2. Chat (core product — 3 fix commits)

**Surface:** `src/app/api/chat/route.ts`, `src/app/chat/*`, `src/lib/ai/*`.

**Why high:** This *is* the product. If chat doesn't stream, nothing else matters.

### Smoke check
- [ ] **`npm run eval`** — runs every canonical query (the suggestion chips, from `src/lib/suggestions.ts`) end-to-end through model + tools + live P21, and fails on a blank answer, a step-cap loop, or a query whose tool calls *all* errored. This is the net that catches query-generation regressions (e.g. the OData date-literal bug — every date-ranged query was silently failing). Run after a deploy, or against a Vercel preview before merging. Hits live P21 + spends a little model budget, so it's a deliberate smoke, not per-commit.
- [ ] Signed in, type a message into `/chat` composer and submit → assistant streams a reply.
- [ ] Submitting again while a stream is in flight is handled (Stop button works, or the second message queues sanely).
- [ ] The `inventorySearch` tool fires for a question like "do we have any M10 screws" → tool call + result render, model continues.
- [ ] Unauthenticated POST to `/api/chat` returns 401 (unless `ALLOW_UNAUTHED_DEV=1` in dev — confirm that bypass is *off* in production).
- [ ] Malformed body to `/api/chat` returns 400, not 500.

### Things that have actually broken
- **`convertToModelMessages` is async** (69eaddb) — must be `await`ed in the route. Without await, the model receives a Promise and errors mid-stream.
- **User message schema was too loose** (760db8a) — `parts: z.unknown()` let a client forge `tool-result` parts the model treated as authoritative. User-role parts must be **text-only** (`UserTextPart`). Don't relax this without server-persisted message state.
- **MessageList lint + body bg drift** (3554634) — style/lint regressions that slipped through. Run `npm run lint` before declaring done.
- **Blank reply: model stops with zero text after tool calls** — gpt-4.1-mini sometimes ends its tool loop on a tool result with `finishReason: "stop"` and no synthesis turn (Sonnet never did this; it surfaced only after the OpenAI switch as "ran all its ERP searches, then nothing"). The route streams via `createUIMessageStream` and, when the loop finishes cleanly with no visible text, runs a **recovery pass** (`toolChoice: 'none'`, tool results replayed) appended to the same assistant message. Don't revert to a bare `result.toUIMessageStreamResponse(...)` — that reintroduces the stall.
- **`result.usage` is the LAST step only** (AI SDK v6) — persisting it undercounted every multi-step tool turn, so the trial spend gate and `/admin/usage` saw a fraction of real provider spend. Persistence must use `result.totalUsage` (plus the recovery pass's usage when it ran).
- **Provider failure modes surfaced as the generic error** — OpenAI quota exhaustion (`insufficient_quota`, a 429 that retrying never fixes) fell through `mapToFriendlyCode` to "Something went wrong." The `provider_quota` code exists for quota/billing/credit-balance strings and must stay ordered BEFORE the `rate_limited` check (quota errors also contain 429).

### When you change `src/app/api/chat/route.ts`
- [ ] `UserTextPart` still rejects non-text parts.
- [ ] `BodySchema` still bounds messages at `.max(50)`.
- [ ] `stepCountIs(10)` is the stop condition (or higher — never unbounded). Was tightened to 4 at one point and the chatbot started returning empty responses on chains like `describeView → viewsQuery (retry) → viewsQuery (retry) → viewsQuery (success)` because the loop terminated before the model got a synthesis step. With `describeView` in the loop, leave plenty of headroom.
- [ ] `prepareStep` still forces `toolChoice: 'none'` on the final step. This guarantees a synthesized text answer instead of a blank when a model would otherwise spend the whole step budget looping on tool calls (seen with gpt-4o-mini repeating a failing PO search 10×). Paired with the self-healing error hints in `tools.ts` (`annotateViewError`), which tell the model to fix-and-not-retry a rejected query.
- [ ] The blank-answer recovery pass still exists: the `createUIMessageStream` execute loop tracks `sawText`/`sawError` and re-prompts with `toolChoice: 'none'` when a clean finish produced no text. Verify the stream still ends with exactly one `finish` chunk (written manually — both phases stream with `sendFinish: false`).
- [ ] Persisted usage comes from `result.totalUsage` (all steps), never `result.usage` (last step only) — the trial gate prices what's persisted.
- [ ] `maxDuration` stays ≥ 300 — multi-step P21 chains (25s proxy timeout per call) regularly exceed 60s, and the function being killed mid-stream is a user-facing stall.
- [ ] `auth()` gate is still in place; the only bypass is the dev `ALLOW_UNAUTHED_DEV` flag.
- [ ] Errors return JSON, not throw — frontend expects shaped error responses.
- [ ] Failed/blank turns are logged to `chat_error` via `logChatError` (`src/lib/chat-errors.ts`) and shown at `/admin/errors`. The write is **fail-safe** — a logging failure (incl. a missing table pre-migration) must be swallowed, never surfaced to the user. Verify: with the `chat_error` table absent, a forced provider error still streams the friendly error to the client and the chat route returns 200, with `[chat-error-log] failed to persist … (swallowed)` in the logs (NOT a 500). This also means the **code can deploy before the migration** (`drizzle/0010_*`) is applied — errors just aren't logged until the table exists. Apply the migration to start capturing.

### When you change `src/lib/ai/tools.ts` or `system-prompt.ts`
- [ ] Smoke-test at least one tool-using prompt end-to-end. Tool-call regressions don't show up in lint.
- [ ] If you add a *mutating* tool, the loose `AssistantMessage.parts: z.unknown()` schema is no longer safe — revisit the comment in `route.ts`.
- [ ] **Descriptive-query routing** (regression: "Stock check on 1/4-20 stainless lock nuts" → 0 rows on a real, in-stock part). A descriptive part/stock request must route through `searchCatalog` FIRST, not a `substringof(...,item_desc)` filter — P21 descriptions are abbreviated (`LOCKNUT` not `LOCK NUT`, `SST` not `STAINLESS`), so literal text matching false-negatives on parts we stock. The steering lives in the "Finding parts by description" prompt block and the "How to answer" bullet; if you edit either, keep `searchCatalog` as the unambiguous first move and don't reintroduce a competing "viewsQuery p21_view_inv_mast first" instruction. The **safety net** is `descriptiveNoMatchHint` in `tools.ts` (attached as `note_no_match` by `finalizeViewResult`): an empty page from an `item_desc` text filter carries a hint steering the model to `searchCatalog` instead of concluding "we don't carry it" — unit-tested in `descriptive-no-match.test.ts`. Smoke: run the exact lock-nut prompt and confirm the model calls `searchCatalog` and surfaces the `25CLNTS` family with live on-hand.

### Accuracy guardrails — confidently-wrong-answer class (`p21-fields.ts`, `aggregate`)
The agent must FAIL LOUD, not quiet: when it can't compute exactly, it says so. The `aggregate` tool computes server-side via the droplet proxy (`POST /proxy/aggregate`): COUNT is exact via P21's `$inlinecount=allpages`, MIN/MAX exact via `$orderby`+`$top=1` (both with NO scan), and SUM/AVG/grouped fold big pages one hop from P21. (`$apply` is NOT supported — confirmed 400 — so there's no server-side SUM; that's why SUM/AVG over a population bigger than the proxy's row/time budget returns `complete:false` with exact coverage `rows_scanned`/`total_count`.) The original symptom was "largest order" → confident `$20k` (a single `oe_line`, not the order); contributing causes were `viewsQuery` returning one capped page and several views lacking the column a question needs (e.g. `oe_hdr` has no order total).
- [ ] `npm test` covers `p21-fields.ts` (redaction set incl. the live-schema audit, schema-driven coercion). Run it after touching the sensitive-column regex or the coercion types.
- [ ] **Aggregation:** totals/counts/averages/rankings route to the `aggregate` tool (which calls `/proxy/aggregate`) — never sum/count the rows of a single `viewsQuery` page. Probe via `npx tsx scripts/eval.ts` (the `ACCURACY_PROBES`). Expect: "how many open sales orders" EXACT (e.g. `126,296`, not "at least N"); "largest order" exact via `invoice_hdr`; full-history "top customers"/"average invoice" return `complete:false` with disclosed coverage. Eyeball that `complete:true` is stated plainly (no hedge) and `complete:false` is disclosed as a sample of `rows_scanned`/`total_count`.
- [ ] **Cost/margin redaction:** as a non-admin without the `pricing` scope, confirm `*_cost`/`gross_margin`/`profit_percent` are stripped from `viewsQuery`/`entityGet`/`aggregate` results, while selling prices (`price1..price10`) survive. Admins (`scopes === "all"`) and `pricing`-scoped users see everything. If you widen the sensitive-column regex, re-run the schema validation that no value column is missed and no selling price is caught.
- [ ] **Truncation honesty:** a full page carries `more_available`/`note_truncation`; the model must report "at least N", never an exact count, off one page.
- [ ] **Availability:** "how many can we ship" must use `qty_on_hand − qty_allocated`, not raw `qty_on_hand`.
- [ ] **Scope denials are not "no data":** a `scope_denied`/`uncategorized_resource` result must surface as "I can't see that with your access", never "there are none".

---

## 3. Status page (1 fix commit, security-class regression)

**Surface:** `src/app/api/status/route.ts`, `src/app/status/page.tsx`, droplet `proxy-server.mjs` and `install.sh`.

**Why mid-list:** Lower change frequency than auth/chat, but the one regression we had (435c0f2) was a data leak — unauthenticated `/api/status` was exposing internal IPs, hostnames, and check details. Re-leaks here are high-impact.

### Smoke check
- [ ] Visit `/status` while signed out → page renders, shows operational/degraded/down per service, **no internal IPs or hostnames anywhere in the HTML or `/api/status` JSON**.
- [ ] Each service shows a 90-day uptime bar that isn't entirely empty.
- [ ] P21 service reflects the droplet's actual health (force a failure on the droplet → status page shows it within the refresh window).
- [ ] The AI-provider card tracks the **active** provider (`AI_PROVIDER`): it must show OpenAI when production runs OpenAI, Anthropic when it runs Anthropic. The droplet probes both `api.anthropic.com/v1/models` and `api.openai.com/v1/models` every run (operational when the probe gets any 2xx/3xx/4xx response — a healthy API replies 401 to the unauth'd request; only 5xx / timeout / connection error → down); `/api/status` picks which to surface via `getActiveProvider()`. The original miss: prod switched to OpenAI while the status page kept watching Anthropic, so a client-facing provider outage showed all-green. No Statuspage fallback — that source was too noisy and was retired.
- [ ] After changing a provider or probe: redeploy the droplet (`scripts/deploy-droplet.sh`) — a Vercel-only deploy leaves the card on "Awaiting upgraded droplet probe" until the droplet emits the new check field.

### Things that have actually broken
- **`/api/status` leaked check details to unauthenticated callers** (435c0f2) — exact IPs, hostnames, HTTP error bodies from internal hosts. Fix was symbolic labels only (`"egress IP mismatch"`, not the actual IP). Re-check after any edit to `buildP21Service`.

### When you change `src/app/api/status/route.ts`
- [ ] `buildP21Service` still emits **symbolic** failure labels, never `latest.checks.<x>.value` or `expected`.
- [ ] No env var values, droplet hostnames, or `DROPLET_HEALTH_URL` echoes leak into the response.
- [ ] `Cache-Control: no-store` is still set (status data must not be cached at the edge).
- [ ] `force-dynamic` export is preserved.

---

## 4. P21 / data path

**Surface:** `src/lib/ai/tools.ts` (`inventorySearch`), droplet `scripts/droplet/proxy-server.mjs`, `P21_API.md`, `P21_Connection.md`.

**Why:** Lower change frequency but high blast radius — if P21 calls break, the product can't answer real questions. Network path is fragile (the hosting provider whitelist, RFC1918 DNS override on the droplet).

### Smoke check
- [ ] Ask the chat a question that triggers `inventorySearch` → tool returns real P21 data, not a connection error.
- [ ] If you changed `proxy-server.mjs`, restart the droplet systemd service and re-run the smoke check above.
- [ ] Droplet health endpoint (`DROPLET_HEALTH_URL`) returns `p21_reachable.ok: true`.

### Things to watch for
- **OData date literals** — P21 is OData **v3**: date filters MUST use typed literals `datetime'YYYY-MM-DDTHH:MM:SS'`. A bare `date_due le 2026-06-17` returns `502 / "Syntax error at position N"`. The system prompt + `viewsQuery` tool description teach this; if a model regresses to bare dates, every date-ranged query ("next 14 days", "shipping this week", "last 30 days") silently fails and the model loops retrying. A blank reply on a date query is the tell.
- **the hosting provider IP allowlist** — the dev egress IP is `<proxy-ip>` (DO Reserved IP on droplet-1 / SFO2). If P21 starts rejecting, confirm the droplet is still routing via that IP.
- **RFC1918 DNS override** — P21's public DNS resolves to a private IP. The droplet's `/etc/hosts` overrides this with `<p21-host-ip>`. If you rebuild the droplet, the override has to be re-applied (see `install.sh`).
- **Proxy credentials** — `proxy-server.mjs` reads creds from env. Missing creds surface as `proxy_up.creds_present: false` in `/api/status`.
- **Proxy rate limit is sized for BURSTS, on a shared IP** — the droplet token bucket (`RATE_CAPACITY` / `RATE_REFILL_PER_SEC` in `proxy-server.mjs`) keys on the source IP, but all app traffic arrives from a few **shared Vercel egress IPs**, so it behaves as a near-global cap. The original `30` capacity / `0.5`-per-sec drained on a single **parallel-tool-call burst** (gpt-4.1-mini issues tool calls in parallel) and `429`'d live reps — observed in prod `2026-06-08` and `2026-06-10`, surfacing to users as "Something went wrong." Now `600` / `10`-per-sec. If you re-tune, size the **burst** (capacity) *and* the recovery (refill), not a per-minute average. This limiter only meters app→droplet request rate; droplet→P21 fold load is bounded separately (`AGG_CONCURRENCY`), so raising it doesn't uncap the shared ERP. **Proper fix:** per-user keying — see `plans/Proxy_Per_User_Rate_Limit.md`.
- **Grain / sentinel / dead-stock class** (the confidently-wrong-*data* class — distinct from the wrong-*number* class in §2). A "top 10 dead stock at 0 stock" list once included a part with 436 units on hand. Three independent data traps, each guarded now:
  - **Grain** — `p21_view_inv_loc` is one row per item × *location* (Olander runs ~3 warehouses); `oe_line`/`invoice_line` are per *line*; lot/bin/serial views per lot/bin/serial. **~81% of inv_loc rows read `qty_on_hand=0` only because the item isn't carried at that location.** Filtering `qty_on_hand eq 0` and listing the rows surfaces phantoms (items fully stocked elsewhere). Company-wide stock must roll up across locations. System prompt has the GRAIN + STOCK AVAILABILITY guardrails; if the model lists raw zero-rows as "out of stock," it regressed.
  - **Sentinel dates** — P21 stores "never sold" as `last_sale_date = 1990-01-01` (186k of 260k inv_loc rows), not null. `nullifySentinelDates`/`nullifySentinelDatesLoose` in `p21-fields.ts` null these (DateTime cols / date-named fields) so the model reads "never," not a fabricated ~36-year age. Unit-tested in `p21-fields.test.ts`. **App-layer only — takes effect with no droplet deploy.** Watch: a "hasn't sold in 36 years" answer means the nullify pass was bypassed.
  - **Find-the-zeros / full-fold timeout** — `aggregate` now takes `order:'asc'` + `having:{op,value}` (returns `groups_matching`) for bottom/zero questions; **a full `inv_loc` fold times out at ~23%**, so the model must filter first (e.g. `qty_on_hand gt 0` → exact in ~12s). The dead-stock recipes live in the system prompt's "DEAD / SLOW-MOVING STOCK" guardrail. **`order`/`having` require a droplet deploy of `proxy-server.mjs`** — until deployed they're ignored upstream (groups still rank desc, no having filter), so verify against the live proxy after restart.

### When you change P21-touching code
- [ ] Re-read `P21_API.md` (auth flow, OData operators, real response shapes; withheld from the public copy) before writing new request code — the API has gotchas that aren't obvious from the response format.
- [ ] No P21 hostnames, internal IPs, or response bodies surface in user-facing errors.
- [ ] If you touched `nullifySentinelDates`/sentinel handling, re-run `p21-fields.test.ts`; if you touched `aggregate` `order`/`having`, deploy `proxy-server.mjs` and re-verify against the live proxy (the app schema change alone is inert without the proxy).
- [ ] If you changed the proxy rate limit (`RATE_CAPACITY` / `RATE_REFILL_PER_SEC`), it only takes effect after a **droplet deploy + service restart**; afterward confirm `/proxy/*` 429s aren't recurring under real load (`journalctl -u olander-proxy -g 'status.:429' --since '15 min ago'`).

---

## 5. Database / Drizzle

**Surface:** `src/db/`, `drizzle/`, `drizzle/meta/_journal.json`.

**Why low:** Stable so far, but a bad migration is hard to roll back on a shared Neon project.

### Smoke check
- [ ] `npm run db:generate` succeeds with no drift after schema edits.
- [ ] After a migration, sign-in still creates a user row and a session row (Auth.js adapter still wired).
- [ ] `drizzle/meta/_journal.json` is committed alongside the migration SQL file.
- [ ] After the `0002` migration: `SELECT email, role FROM member` shows the seeded bootstrap admins (+ a row per pre-existing `user`). Some migration steps in `0002` are hand-written SQL appended after the generated `CREATE TABLE` — re-generating won't reproduce them, so don't regenerate `0002`.

### Things to watch for
- **One Neon project only** (`<neon-project-id>`, Vercel-managed, `aws-us-west-2`) — do *not* create a second project. See `db.md`.
- **Schema drift** — if you edit `src/db/schema.ts` without running `db:generate`, the deployed DB diverges silently. Always generate + commit the migration.

---

## 6. Retrieval / catalog-vector index

**Surface:** `src/lib/ai/tools.ts` (`searchCatalog`), `src/lib/ai/embeddings.ts`, `src/lib/ai/qdrant.ts`, `src/db/schema.ts` (`catalog_item`), `drizzle/0002_*` + `drizzle/0003_*` + `drizzle/0004_*`, `scripts/backfill-catalog.ts`, `scripts/sync-catalog.ts`, `scripts/create-qdrant-collection.ts`, `src/app/api/cron/sync-catalog/route.ts`, `vercel.json` cron entry. See [`RETRIEVAL.md`](RETRIEVAL.md) for design and [`Retrieval_Runbook.md`](Retrieval_Runbook.md) for ops.

**Why low (for now):** brand-new surface. The lock-step write order (Qdrant first, Neon hash second) is load-bearing and the most likely place a regression would surface.

### Smoke check
- [ ] Ask the chat a descriptive part question ("M10 stainless cap screw, around 50mm") → model picks `searchCatalog`, top result is the obvious SKU.
- [ ] Ask an exact-SKU question ("show me PN12345-01") → model picks `entityGet` (or `viewsQuery`), **not** `searchCatalog`.
- [ ] After `searchCatalog`, the model chains into `viewsQuery p21_view_inv_loc` for live stock.
- [ ] `npx tsx --env-file=.env.local scripts/smoke-search-catalog.ts` passes all 10 hand-picked descriptive queries with the expected SKU in top-3 (runs against an isolated `olander-catalog-smoke` Qdrant collection that's torn down after). Add `VOYAGE_QPS_DELAY_MS=22000` only if Voyage is on the no-billing free tier (3 RPM cap).

### Things to watch for
- **Vector dim must stay 1024.** Every Voyage call pins `output_dimension=1024`; the Qdrant collection is created with `size: 1024` (validated by `scripts/create-qdrant-collection.ts` on every run — mismatch refuses to continue). A vendor default flip is the only realistic way this could break.
- **Qdrant write must come before Neon hash update.** The backfill/sync code is written so Qdrant upsert happens first, then the Neon hash is bumped. If Qdrant fails, the Neon hash stays stale and the next sync retries. Reversing the order would create rows that *claim* to be embedded while Qdrant has no vector — silently missing from search until the row's text changes again. Don't refactor the write order without auditing this invariant.
- **`delete_flag` lives in two places.** Soft-delete writes BOTH the Neon row (`set: { deleteFlag: true }`) AND the Qdrant payload (`setCatalogPayload(uid, { delete_flag: true })`). The query filter is on the Qdrant side. Forgetting to flip Qdrant leaves a "ghost" SKU answering descriptive queries even though Neon shows it deleted.
- **`delete_flag` is boolean, not `'Y'`/`'N'`.** The droplet proxy normalizes P21's `"Y"`/`"N"` flags to JSON booleans before they reach us; both Neon's column and Qdrant's payload mirror that. Write `true`/`false`, query against `delete_flag = false`.
- **Local backfill needs unblocked network access to the droplet AND respect the proxy's per-IP request bucket** (`RATE_CAPACITY` / `RATE_REFILL_PER_SEC` in `proxy-server.mjs` — raised 30→600/min on 2026-06-10). The script's `PAGE_DELAY_MS` (default 2500) keeps us well under that. Corporate TLS-interception middleboxes (Fortinet, Zscaler) break Let's Encrypt cert validation; production (Vercel) sees no middlebox.
- **`/api/cron/sync-catalog` is gated on `CRON_SECRET`.** Without it, the endpoint always 401s. Confirm it's set in Vercel project env (Production + Preview). Also confirm `QDRANT_URL` and `QDRANT_API_KEY` are set there or the endpoint 503s with `qdrant_not_configured`.
- **Voyage free tier without billing is 3 RPM / 10K TPM.** Production traffic needs a payment method on file; first 200M tokens stay free either way.
- **Qdrant Cloud free tier is 4 GB / single node.** ~99K vectors at 1024d sits at ~700 MB, comfortable. The cap is the practical ceiling on adding a second collection (docs, customer embeddings) without upgrading.

### When you change `embeddings.ts` or the embed-input shape
- [ ] Run `npm test` — the unit tests pin `buildEmbedInput`'s exact output for several real Olander-shaped rows. Changing the shape changes every hash, which forces a full re-embed on next sync. Make sure that's what you want.
- [ ] Sanity-check token usage in `backfill-catalog.ts` logs after a re-run — a runaway loop should hit the 50M cap; normal operation is ~3M tokens for a full catalog.

### When you change `searchCatalog` or `qdrant.ts`
- [ ] Run the smoke-search script — exercises the live Qdrant path end-to-end against a known-good 20-row corpus in an isolated collection.
- [ ] If you change the returned columns, update `src/lib/ai/tool-labels.ts`'s `matchCount`/`extractRows` and `src/components/chat/ToolCallCard.tsx`'s `extractRows` branch so the UI still surfaces results.
- [ ] If you change `QDRANT_COLLECTION` or dim, run `scripts/create-qdrant-collection.ts` first — it validates the existing collection matches the config and refuses to proceed on mismatch. Qdrant collections are fixed-dim at creation; a dim change requires a new collection.

---

## 7. UI / styling

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
