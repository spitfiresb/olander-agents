# P21 Integration — Status & Roadmap

Where we are on getting Olander's chatbot to actually answer questions from P21 data, and what's blocked.

> **Scope:** living doc, updated as we move. For *how to reach P21 over the network*, see [`P21_Connection.md`](./P21_Connection.md). For *droplet operations*, see [`Droplet.md`](./Droplet.md).

## The three layers

End-to-end, "rep asks a question and gets a P21-backed answer" is three layers stacked. Each one is independently testable; each one blocks the next.

```
┌───────────────────────────────────────────────────────────────────┐
│ Layer 3: Chatbot tool-calling                          [NOT DONE] │
│   /api/chat exposes tools (searchInventory, lookupCustomerOrders, │
│   etc.). LLM invokes tools as needed. Tools call Layer 2.         │
└───────────────────────────────────────────────────────────────────┘
                                 ↑
┌───────────────────────────────────────────────────────────────────┐
│ Layer 2: P21 proxy on the droplet                      [NOT DONE] │
│   Service behind Caddy at <egress-host>/proxy/*.       │
│   Authenticates Vercel callers (bearer token), translates to P21  │
│   REST calls, returns responses. Inherits SNAT + /etc/hosts.      │
└───────────────────────────────────────────────────────────────────┘
                                 ↑
┌───────────────────────────────────────────────────────────────────┐
│ Layer 1: Secure network path                                [DONE]│
│   Whitelisted egress, /etc/hosts override, TLS-fronted droplet,   │
│   firewall, observability. <egress-host>/health green. │
└───────────────────────────────────────────────────────────────────┘
```

## Layer 1: Secure network path — DONE

Verified as of 2026-05-10:

- `<proxy-ip>` whitelisted at the hosting provider (Reserved IP, region-locked SFO2).
- SNAT rewrites all outbound traffic so external services see the whitelisted IP. Verified by `curl ifconfig.me` from droplet returning `<proxy-ip>`.
- `/etc/hosts` override on droplet maps `<p21-host> → <p21-host-ip>`; `curl https://<p21-host>/prophet21/` returns HTTP 200.
- `<egress-host>` resolves to droplet (Cloudflare DNS, gray cloud / DNS-only). Caddy serves a real Let's Encrypt cert; auto-renews every ~60 days.
- Firewall: only 22/80/443 inbound. Health-server bound to `127.0.0.1:8088`; unreachable from outside the box.
- `/status` page polls `/api/status` which calls the droplet's `/health` over TLS with a bearer token. All four checks (egress IP, DNS override, P21 reachable, TLS cert expiry) green; uptime visible in 1h/24h/7d windows.

Implementation references: [`Droplet.md`](./Droplet.md) (the full operational picture), [`P21_Connection.md`](./P21_Connection.md) (P21-specific connectivity), `scripts/droplet/` (the bundle), `src/app/status/page.tsx` (the dashboard).

## Layer 2: P21 proxy — NOT STARTED

**What it is:** a small service running on the droplet, fronted by Caddy at `<egress-host>/proxy/*`. It authenticates Vercel callers (same bearer-token pattern as `/health`), maps incoming requests to P21 REST calls, and returns responses. The droplet's existing SNAT + `/etc/hosts` override mean the proxy just needs to `curl https://<p21-host>/...` — no special networking.

**What's blocking:** we don't yet have:

1. **P21 API auth method.** Bearer token? Session-based? Username/password to `/api/security/Token` to mint a session? Per the hosting provider REST conventions it's likely the latter, but unconfirmed. This determines how the proxy talks to P21.
2. **Endpoint catalog / OpenAPI spec.** Which routes for inventory lookup, customer history, order list, price lists, etc. P21's REST API has a Swagger doc somewhere — needs to be fetched and skimmed.
3. **Read scope confirmation.** We're told read-only against the play env; need confirmation that the credentials we get reflect that.

**What unblocks it:** ask the provider contact for (1) credentials for the play env, (2) a pointer to the Swagger doc or example requests. Once we have those, the proxy itself is ~half a day:

- Pick stack: Node (matches Next.js skills) or Python (matches the existing health-server). Lean Node — the AI SDK runs in Node, and the proxy will end up shaped a lot like an SDK adapter.
- Define a small request shape: `POST /proxy/<endpoint-name>` with a JSON body. The proxy validates the bearer, opens (or refreshes) a P21 session, makes the upstream call, returns the response.
- Add to `Caddyfile`: a second `handle` block matching `path /proxy/*` reverse-proxying to the new service on a second loopback port.
- Extend `install.sh` to install the proxy service (systemd unit, EnvironmentFile for P21 creds).
- Extend `healthcheck.sh` to add a 5th check: "proxy is up" (curl `127.0.0.1:8089/healthz` or similar).

**Worth doing manually first:** before writing the proxy, SSH into the droplet and `curl` P21 by hand. The droplet inherits all the network plumbing — only the auth header is missing. This is the cheapest way to validate the auth pattern before committing to a proxy shape.

## Layer 3: Chatbot tool-calling — NOT STARTED

**What it is:** `/api/chat/route.ts` currently calls Claude with a system prompt and no tools. To make `"What size helicoil goes in this hole?"` actually work, we add tool definitions to the `streamText` call (Vercel AI SDK's native tool-calling). Each tool wraps a Layer 2 proxy call.

**What's blocking:** Layer 2. There's no tool to define until the proxy can return data.

**What it'll look like (sketch):**

```ts
// src/lib/ai/tools.ts (future)
import { tool } from "ai";
import { z } from "zod";

export const searchInventory = tool({
  description: "Search the warehouse inventory for items matching the criteria.",
  parameters: z.object({
    threadSize: z.string().optional(),
    material: z.string().optional(),
    length: z.string().optional(),
  }),
  execute: async (args) => {
    const res = await fetch(`${process.env.DROPLET_PROXY_URL}/proxy/inventory_search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.DROPLET_PROXY_TOKEN}` },
      body: JSON.stringify(args),
    });
    return await res.json();
  },
});
```

The five anchor use cases from `VISION.md` map to roughly this many tools:

- **Catalog & spec lookup** — 1 tool
- **Vendor sourcing** — 1 tool
- **Customer order history** — 1 tool
- **Marketing / account lists** — 1 tool (likely the most query-shaped of these)
- **Inventory search** — 1 tool

Each has its own P21 endpoint(s) underneath. Some may decompose into multiple sub-tools as we feel out what the LLM does well with.

## What you can do *right now*

Until Layer 2 lands, the chatbot is just Claude talking — useful for design feedback, useless for real lookups. Two productive things to do in the meantime:

1. **Manually explore the P21 API from the droplet** to learn the auth pattern. SSH in, curl with whatever credentials we get from the provider contact, capture example requests/responses. This directly informs the proxy shape.
2. **Watch `/status`** to confirm Layer 1 keeps working as we make changes. If anything goes red, the dashboard tells us before users would.

## Next steps (in order)

1. **Get credentials from the provider contact** for P21 play env, plus Swagger / endpoint docs. *Blocking.*
2. **Manually validate auth** by hand-curling 2–3 endpoints from the droplet.
3. **Build the proxy** (Layer 2). Deploy via `install.sh` extension.
4. **Wire one tool** end-to-end (Layer 3). Recommend starting with `inventory_search` — it's the highest-frequency, highest-value rep query per `VISION.md`.
5. **Add the remaining four tools.** Each iteration improves the system prompt as we see what the LLM does well/poorly.
