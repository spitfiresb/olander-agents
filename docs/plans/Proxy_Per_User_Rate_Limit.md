# Follow-up: per-user keying for the droplet proxy rate limit

**Status:** proposed (interim raise already shipped — see below)
**Owner:** Alex (original author of `proxy-server.mjs`)
**Filed:** 2026-06-10, after diagnosing live `429`s in prod.

## TL;DR

The droplet's rate limiter (`scripts/droplet/proxy-server.mjs`) keys on the
**source IP**, but every app request reaches it from a small pool of **shared
Vercel egress IPs** — so the "per-IP" limit is effectively one near-global
bucket for the whole company. It was sized at `30` capacity / `0.5`-per-sec,
which a single parallel-tool-call burst drains instantly. That `429`'d real reps
in production (surfacing as "Something went wrong").

**Interim fix (done):** raised to `600` capacity / `10`-per-sec. Stops the
bleeding; does **not** fix the design — one runaway rep can still eat the shared
bucket and throttle everyone.

**Proper fix (this doc):** key the bucket on the **user**, not the IP.

## Evidence

`journalctl -u olander-proxy -g 'status.:429'` showed two bursts, each from a
single IP, requests spaced **sub-millisecond** (far faster than sequential agent
steps — consistent with gpt-4.1-mini's parallel tool calls):

- `2026-06-08 23:13–23:14` — IP `<redacted-ip>`, ~40× on `p21_view_inv_loc`.
- `2026-06-10 17:49` — IP `<redacted-ip>`, burst on `p21_view_customer`.

A diagnostic `ip` field was added to the `/proxy/*` success logs (same change)
so the IP-sharing question can be confirmed directly:
`journalctl -u olander-proxy -o cat | jq -r 'select(.path|startswith("/proxy/")).ip' | sort | uniq -c`.

## The change

### App side — `src/lib/ai/tools.ts`
`callProxy` currently sends only `Authorization: Bearer <PROXY_TOKEN>`. Add a
per-request identity header, e.g. `X-Olander-User: <userId>`. The tools are built
per request via `buildTools(scopes, catalog)` from `route.ts`, where `userId` is
already in scope — thread it into the factory → `callProxy`. (A handful of
signature changes; no new dependency.) Fall back to no header in the dev-bypass
path (no `userId`).

### Droplet side — `scripts/droplet/proxy-server.mjs`
Replace `clientIpFor(req)` as the rate key with a `rateKeyFor(req)` that prefers
`X-Olander-User` and **falls back to the IP** when it's absent. The token-bucket
math (`rateCheck`) is unchanged — only the key changes. Keep a generous
**global/IP backstop** underneath so a compromised app can't mint infinite
synthetic user IDs to bypass the cap (defense in depth).

### Trust model (important, but it holds)
The droplet would now trust an app-asserted header. That is safe **because it
sits behind the shared bearer token**: only the server holds `PROXY_TOKEN`,
browsers never see it, so a client can't forge another user's header without
already being our server. It is a rate-limit **partition key, not an auth
boundary** — real auth still happens in the app. Document that one sentence in
the code so nobody later mistakes it for authentication.

### Sizing
Whatever the per-user cap, size it for **one user's realistic burst**, not an
average: the app already permits 20 messages/min/user and up to ~10 tool calls
per turn, so a heavy user is plausibly 30–60 proxy calls/min. A per-user cap of
~60–120/min with burst capacity for a parallel-tool-call wave is reasonable.

## Why it's testable (not a shot in the dark)

This is a **key swap on an existing, production-proven mechanism**, not a new
system. The exact production failure mode is **directly reproducible against the
droplet** with scripted curl — no real Vercel or concurrency needed:

1. **Unit** — extract `rateKeyFor` (pure: header-or-IP) and unit-test it; the
   token bucket is unchanged and already proven in prod.
2. **App** — assert `callProxy` forwards `X-Olander-User: <userId>`, and omits it
   on the dev-bypass path.
3. **Integration (the money test)** — hit the droplet with the **same** XFF but
   **different** `X-Olander-User` values → each user gets its own allowance
   before any `429` (this *is* the "20 reps behind one Vercel IP" scenario);
   **same** user header → throttles at the cap; **no** header → falls back to IP.

## Rollout (no breaking window)

Because it **degrades gracefully** (no header ⇒ fall back to IP ⇒ identical to
today), deploy the **droplet first** — behavior is unchanged until headers start
arriving — validate with the curl script in isolation, *then* ship the app change
that begins sending the header. Nothing breaks in between.

## Effort

Moderate, not large: the hard part (the bucket) already exists. Roughly a focused
half-day including tests and the two deploys; low algorithmic risk.
