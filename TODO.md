# TODO — P21 Integration Build-Out

Temporary punch list. Delete when Layer 2 + Layer 3 are live and the chatbot is answering real questions.

For background on *why* and *how*, read `docs/P21_API.md` (API reference) and `docs/P21_Connection.md` (network plumbing). This file is just the task list.

## Status at a glance

- Layer 1 (network path): **done.** Droplet, SNAT, DNS override, Caddy/TLS, /status dashboard all green.
- API access from the droplet: **verified.** Can mint tokens, query views, fetch entities with the `OregonTC` user/pass we have.
- Layer 2 (proxy on droplet): **live and verified.** All four production-readiness checks green via `./scripts/verify-droplet.sh` (viewsQuery returns normalized rows, entityGet returns part records, healthz reports `creds_present:true` + `p21_reachable:true`, bad bearer → 401).
- Layer 3 (chatbot tools): **live and exercised.** 4 of 5 anchor questions return correct, tool-backed answers against real P21 play data; the 5th (cross-customer marketing query) decomposes correctly but needs richer view-schema knowledge in the system prompt — captured as a follow-up below, not a blocker.
- Credentials on droplet: **deployed** to `/etc/olander-proxy.env` (root, 0600).

## Layer 2: P21 proxy on the droplet

### Decisions locked in

- [x] Stack: **Node** (matches the rest of the codebase, lets us reuse the same fetch/zod shapes the AI SDK uses).
- [x] Service name + loopback port: `olander-proxy.service` on `127.0.0.1:8089` (matches the placeholder already in `.env.local`).
- [x] Auth-translation strategy: proxy mints + caches one P21 token, refreshes proactively at ~90% of TTL. Vercel callers present `DROPLET_PROXY_TOKEN` (bearer); proxy swaps it for the P21 bearer upstream.
- [x] Response normalization: snake_case keys everywhere, `"Y"/"N"` → JSON booleans (only on flag-like field names to avoid false positives), numeric strings → numbers for known columns. Implemented in `scripts/droplet/proxy-server.mjs`.

### Proxy service — code

- [x] `scripts/droplet/proxy-server.mjs` rewritten.
- [x] Routes:
  - [x] `POST /proxy/views/:viewName` — body `{ filter?, top?, skip?, select?, orderBy? }`. Proxies to `/data/erp/views/v1/<viewName>?...`. Normalizes response.
  - [x] `GET /proxy/entity/:area/:resource/:id` — query `?extendedProperties=...`. Proxies to `/api/<area>/<resource>/<id>`. Normalizes response.
  - [x] `GET /proxy/healthz` — returns 200 with `{ ok, creds_present, token_age_seconds, p21_reachable }`. Consumed by `healthcheck.sh`.
- [x] Bearer-token check against `OLANDER_PROXY_TOKEN` (timing-safe) on every request including `/proxy/healthz`.
- [x] Token cache: in-memory only; proactive refresh at 90% of JWT `exp`; reactive refresh on `<TokenError>` 401 with one-shot retry.
- [x] Error mapping: P21's `<TokenError>` XML and upstream timeouts surface as clean JSON `{ error, status }` so tool code never has to parse XML.
- [x] Structured JSON logs to stdout (systemd captures into journald). Authorization headers are never logged; URL query keys matching `password|consumer_key|token|authorization` get `<redacted>`.

### Droplet deployment scripts (in repo — need user to ship)

- [x] `scripts/droplet/install.sh`:
  - [x] Already installs Node + symlinks `/usr/bin/node` on Ubuntu 24.04.
  - [x] Already copies proxy code to `/usr/local/bin/olander-proxy-server.mjs`.
  - [x] Creates/updates `/etc/olander-proxy.env` mode `0600`, root-owned, now with `P21_BASE_URL` seeded and a comment block reminding the operator to append `P21_USERNAME` / `P21_PASSWORD` (or `P21_CONSUMER_KEY`).
  - [x] Installs `/etc/systemd/system/olander-proxy.service` with `EnvironmentFile=/etc/olander-proxy.env`, `Restart=on-failure`.
  - [x] `systemctl enable --now olander-proxy`.
  - [x] Warns (does not fail) if no P21 credentials are present yet so the operator sees they need to append them.
- [x] `scripts/droplet/Caddyfile`: already has `handle @proxy path /proxy/*` block reverse-proxying to `127.0.0.1:8089`.
- [x] `scripts/droplet/healthcheck.sh`: already calls `http://127.0.0.1:8089/proxy/healthz` with the proxy bearer, reads `creds_present`, and includes a `proxy_up` field in `latest.json`.

### User actions required to declare Layer 2 done

All three steps below are wrapped into two scripts. Run them in order from the repo root:

- [x] **Deploy:** `./scripts/deploy-droplet.sh`
  - Reads `P21_USERNAME` / `P21_PASSWORD` / `P21_BASE_URL` from `.env.local`.
  - scp's `scripts/droplet/*` to the droplet, runs `install.sh`, merges P21 creds into `/etc/olander-proxy.env` without putting the password on a command line, restarts the service, probes `/proxy/healthz` and verifies `creds_present:true`. Idempotent — safe to re-run.
  - Overrides if needed: `DROPLET_HOST=...`, `SSH_KEY=...`, `OLANDER_DOMAIN=...`.

- [x] **Verify:** `./scripts/verify-droplet.sh`
  - Pulls `DROPLET_PROXY_URL` / `DROPLET_PROXY_TOKEN` from `.env.local` and runs the four production-readiness checks:
    1. `POST /proxy/views/p21_view_inv_mast` returns a normalized row.
    2. `GET  /proxy/entity/inventory/v2/parts/<item_id>` returns a record.
    3. `/proxy/healthz` reports `creds_present:true`.
    4. `/proxy/healthz` with a bad bearer returns 401.
  - Prints a green `✓`/red `✗` summary; exits non-zero on first failure.

- [ ] **Visual check** (optional): visit `/status` and confirm the `proxy_up` row is green. The healthcheck timer is already wired; the page should update within ~60s of a successful deploy.

## Layer 3: chatbot tools

- [x] Two thin tools in `src/lib/ai/tools.ts`:
  - [x] `viewsQuery({ viewName, filter?, top?, skip?, select?, orderBy? })` → POSTs to `${DROPLET_PROXY_URL}/proxy/views/<viewName>`.
  - [x] `entityGet({ area, resource, id, extendedProperties? })` → GETs `${DROPLET_PROXY_URL}/proxy/entity/<area>/<resource>/<id>`.
  - [x] Both zod-validated. `viewName` regex-guards the `p21_view_*` prefix on the client side too (defence in depth — proxy enforces same).
- [x] `src/lib/ai/system-prompt.ts` rewritten: teaches the model the two tools' contracts, the view-name prefix rule, OData operator vocabulary, snake_case post-normalization output shape, and example invocations against `p21_view_inv_mast`, `p21_view_customer`, `p21_view_oe_hdr`. Includes guidance on the proxy error envelope so the model degrades gracefully when P21 / proxy is unhealthy.
- [x] Retired the catalog-search stack: deleted `src/lib/p21/catalog-search.ts`, `src/lib/p21/embeddings.ts`, `scripts/sync-catalog.ts`, the unapplied `0001_even_otto_octavius` migration (catalog_item never landed in prod), the `catalog_item` table from `src/db/schema.ts`, and the `catalog:sync` npm script. `mocks/p21/catalog.json` retained for now (one file; no maintenance cost). `tsc --noEmit`, `next build`, and `eslint` are clean.

### Smoke-test results (run 2026-05-11)

Five anchor questions exercised end-to-end via the dev server and `/chat`:

- [x] **Catalog & spec lookups:** "What helicoil do we carry for a 1/4-20 tapped hole?" → ✓ one `viewsQuery` on `p21_view_inv_mast`, three real SKUs returned (`1185-4CN625S`, `7571-4B-60`, `7553-4`), correctly distinguishing insert from tools.
- [x] **Vendor sourcing:** "Which vendors do we have for bronze cap screws?" → ✓ four chained tool calls, surfaced real silicon-bronze socket-cap SKUs (`25C75SHCQ`, `25C125SHCQ`, `31C150SHCQ`). Honest that supplier sub-object came back null — see follow-up below.
- [x] **Customer order history:** "Show me the last 10 orders." → ✓ 10 real orders with `order_no`, `customer_id`, `order_date`. Model self-corrected one column-name mistake mid-stream.
- [ ] **Marketing / account lists:** "Which customers bought stainless in the last 12 months but haven't ordered in 90 days?" → ⚠ partial. Model decomposes the question correctly but burns budget on *schema discovery* for the order-line view. Even with `stepCountIs(8)` it ran out of steps before joining items → orders → customers. Real fix is **prompt schema knowledge**, not budget — see follow-up below.
- [x] **Inventory search:** "All M10x1.25 screws we have." → ✓ 50+ items, categorized (hex bolts / nuts / heli-coil / threaded rod / inserts) after one self-correction. Best answer of the set.

### Follow-ups from the smoke test

- [ ] **Order-line view schema in the system prompt.** Q4 needs `p21_view_oe_line` (or whatever Olander's actual line-level view is named) with verified column names (order_no, item_id, customer_id, qty_ordered, line_no). Without that, the model has to discover the schema via trial-and-error and exhausts the step budget. Find the view name by browsing `/data/erp/views/v1/$metadata` through the droplet, then add it to `src/lib/ai/system-prompt.ts` alongside the other six views.
- [ ] **`extendedProperties` value for parts.** Q2 surfaced bronze SKUs but vendor sub-objects came back `null` because the proxy didn't pass the right `extendedProperties` string. Find the correct value (probably "Suppliers" or "Suppliers,UnitsOfMeasure") via `/api/inventory/v2/parts/help/operations/GetPartV2` on the droplet and document it in the system prompt so the model knows when to pass it.
- [ ] **Pricing / stock-on-hand.** None of the answers cite price or quantity-on-hand. Once `p21_view_inv_loc` is added to the prompt with column names verified, "do we have stock?" becomes a real answer instead of catalog-only.

## Follow-ups (don't block Layer 2/3, but should land soon after)

- [ ] **Consumer Key.** Ask the provider contact to register one named `OlanderAgents`, scope `/api;/data`, type `Service`, TTL 30 days or never-expire. Then drop `P21_USERNAME`/`P21_PASSWORD` from `/etc/olander-proxy.env` and add `P21_CONSUMER_KEY=...` — the proxy already prefers it when present.
- [ ] **Observability.** Wire proxy stdout (journald) into the existing `/status` dashboard or a small log endpoint so we can see request rate, error rate, p99 latency without SSHing in.
- [ ] **Rate-limit hardening.** Caddy already terminates TLS; add a simple per-IP rate limit on `/proxy/*` so a misbehaving Vercel deploy can't accidentally hammer P21.

## Open questions / decisions

- **Should the proxy expose `$expand`-style sub-resource fetches in one call**, or always force the caller to do `viewsQuery` then `entityGet`? Leaning two-call for simplicity; revisit if latency hurts. `entityGet` already accepts `extendedProperties` which covers most needs.
- **How should the proxy surface field metadata** (which columns exist on which view) to the LLM? Options: (a) hardcode a small allowlist in the system prompt — chose this for now, (b) expose a `viewsDescribe(viewName)` tool that returns `$metadata`-style column info. Defer until we see the LLM struggle.
- **Token refresh on 401 vs proactive:** doing both — proactive at 90% of TTL, plus reactive one-shot retry on a `<TokenError>` 401.

---

When this list is empty: delete this file.
