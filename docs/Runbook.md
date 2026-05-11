# Runbook

Day-to-day operations for Olander Agents. Aim of this doc: someone on
Olander's IT side should be able to follow it without involving us.

## Topology recap

```
 user (browser)  ─►  Vercel (Next.js)  ─►  Anthropic
                          │
                          └─►  DigitalOcean droplet  ─►  P21 (the hosting provider)
                          │       (proxy + Caddy)
                          ├─►  Neon Postgres  (auth + chat history)
```

## Deploying

1. Merge to `main`. Vercel auto-deploys.
2. Watch the build in the Vercel dashboard. A failed build never replaces
   the running deployment — old version stays up.
3. After Vercel reports ready, hit `https://<host>/api/status` to confirm
   everything is green.

### Hotfix path

- Vercel → Deployments → pick a previous green deployment → **Promote to
  Production**. Takes ~30 seconds, no rebuild.

### Database migrations

```bash
DATABASE_URL=<prod-pooled-url> npm run db:migrate
```

Migrations live in `drizzle/`. Always commit the matching `drizzle/meta/_journal.json`.

## Rotating the P21 Consumer Key

1. Ask the provider contact for a new key (name `OlanderAgents`, scope `/api;/data`).
2. SSH to the droplet. Edit `/etc/olander-proxy.env`:
   ```
   P21_CONSUMER_KEY=<new-key>
   ```
3. `sudo systemctl restart olander-proxy`.
4. `curl -H "Authorization: Bearer $TOKEN" https://egress.<domain>/proxy/healthz`
   — confirm `creds_present: true` and a recent `token_age_seconds`.

Note: when `P21_CONSUMER_KEY` is set, `P21_USERNAME` / `P21_PASSWORD` are
ignored. Remove the username/password after switchover.

## Adding an allowed sign-in domain

Edit `ALLOWED_DOMAINS` in `src/lib/auth-allowlist.ts`. Ship a deploy. Then:
- If the new domain belongs to a different Entra tenant, also add the
  tenant GUID to `AUTH_ALLOWED_TENANT_IDS` in Vercel env vars.
- An empty `AUTH_ALLOWED_TENANT_IDS` fails closed — verify it's still
  populated after any env change.

## Reading logs

| Where | What |
|-------|------|
| Vercel → Logs | App requests, `/api/chat` errors, `[chat] usage` |
| Droplet: `journalctl -u olander-proxy -f` | Proxy traffic, P21 mint / errors |
| Anthropic console → Usage | Tokens by day, spend |
| Neon console → Monitoring | DB CPU / connections |

### Forwarding droplet logs off-host (optional)

Right now you have to SSH the droplet to read proxy logs. To get them in a
browser, pick one of:

- **Better Stack (Logtail)** — cheapest, ships journald lines as-is.
  Install: `curl -fsSL https://logs.betterstack.com/setup-vector | sh`, drop
  the source token into the install script, restart Vector. The
  `olander-proxy.service` unit already writes JSON one-line per event to
  stdout — Vector forwards verbatim.
- **Grafana Loki + Promtail** — heavier but free-tier-friendly. Configure
  promtail to read `journalctl -u olander-proxy -o json`.
- **Vercel Drains** — only useful for app logs, not droplet logs.

If you skip this for handoff, document in the privacy memo that proxy
logs live only on the droplet (and are wiped on rebuild).

Grep for `[chat] possible internal-address leak` in Vercel logs — flags
when an assistant response contained an RFC1918 IP or `*.internal`
hostname. Should be empty.

## When `/status` shows red

- **P21 proxy** red → SSH droplet, `systemctl status olander-proxy`. If
  the service is up but `/proxy/healthz` returns `creds_present: false`,
  re-check `/etc/olander-proxy.env`.
- **Anthropic** red → check `status.anthropic.com` for a provider
  incident. Verify the API key is still active.
- **Auth** errors at the branded `/auth/error` page → most likely the
  Entra app secret expired. Generate a new one in Azure portal, update
  Vercel env, redeploy.

## When P21 starts rejecting

1. Confirm droplet's egress IP is still `<proxy-ip>`
   (`curl -s ifconfig.me` on the droplet).
2. Confirm `/etc/hosts` on the droplet still pins
   `<p21-host> → <p21-host-ip>` (per `docs/P21_Connection.md`).
3. If the IP changed, ask the provider contact to refresh the the hosting provider allowlist.

## On-call escalation

| Vendor | Where it breaks | How to file |
|--------|----------------|-------------|
| Anthropic | Streaming errors, 5xx from the model | https://status.anthropic.com + Anthropic support email |
| Vercel | Build / deploy / edge errors | Vercel dashboard → Support |
| Neon | DB unavailable / `creds_pending` | Neon dashboard → Support |
| DigitalOcean | Droplet down / network issue | DO dashboard → Support |
| the hosting provider / P21 | Auth or data path failure | the provider contact at Olander |

## Anthropic budget cap

Set a monthly spend ceiling in the Anthropic console under
**Billing → Usage limits**. Suggest $500/mo to start. Alerts at 50% /
80% / 100% to ops email.

## Backups

Neon has point-in-time recovery enabled on the `<neon-project-id>`
project. To restore to a prior moment:

1. Neon console → Branches → "Create branch from time".
2. Pick the moment (resolution: 1 minute).
3. Note the new branch's connection string.
4. Update `DATABASE_URL` in Vercel env to the branch's connection. Redeploy.
5. After verifying the data is what you want, either keep that branch as
   the new primary or copy rows back to the original.

## Secrets

Canonical store: 1Password vault `Olander Agents` (set up at handoff).
Mirrored to Vercel env vars (production) and `/etc/olander-proxy.env`
(droplet). Anything seen in a chat or screenshot should be rotated.
