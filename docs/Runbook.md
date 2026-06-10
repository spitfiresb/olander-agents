# Runbook

Day-to-day operations for Olander Agents. Aim of this doc: someone on
Olander's IT side should be able to follow it without involving us.

## Topology recap

```
 user (browser)  ─►  Vercel (Next.js)  ─►  AI provider (AI_PROVIDER env:
                          │                openai today — gpt-4.1-mini;
                          │                anthropic / google switchable)
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

## Managing who can sign in (members)

Access is per-email, controlled in the app — no deploy needed.

- **Add / re-invite:** sign in as an admin → `/admin` → **Members** → enter an
  email, pick `User` or `Admin`, **Add member**. Inviting someone before they've
  ever signed in works — the tier you pick is applied on their first login.
  Re-adding an email that was removed earlier re-invites them.
- **Change tiers:** flip the per-row `User`/`Admin` toggle(s), then **Save
  changes** (top-right of the table). Nothing is written until you click Save.
- **Remove:** the red **Remove user** button on a row — they're signed out and
  lose all access immediately; their account and chat history are kept and they
  drop off the list. Re-add the email to restore them.
- **Break-glass / first admin:** `AUTH_BOOTSTRAP_ADMINS` in Vercel env vars —
  comma-separated emails that are always allowed and always admin regardless of
  the table. Keep it to 1-2 trusted accounts.
- **A new Entra tenant:** the sign-in still requires a matching `tid`, so add the
  tenant GUID to `AUTH_ALLOWED_TENANT_IDS` in Vercel env vars. An empty
  `AUTH_ALLOWED_TENANT_IDS` fails closed — verify it's still populated after any
  env change.
- A non-allowed (or revoked) account sent to sign in lands on the branded
  `/auth/error` page.

## Reading logs

| Where | What |
|-------|------|
| Vercel → Logs | App requests, `/api/chat` errors, `[chat] usage` |
| Droplet: `journalctl -u olander-proxy -f` | Proxy traffic, P21 mint / errors |
| OpenAI platform → Usage (active provider) | Tokens by day, spend |
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
- **AI provider** red (the card names whichever provider `AI_PROVIDER`
  makes active — OpenAI today) → check the provider's status page
  (`status.openai.com` / `status.anthropic.com`) for an incident. Verify
  the API key is still active AND the account has credit — a burst of
  "out of credits" errors in chat means the provider account's balance or
  quota ran out, which no retry fixes; top up in the provider console.
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
| OpenAI (active AI provider) | Streaming errors, 5xx from the model, quota | https://status.openai.com + platform.openai.com support |
| Anthropic (if switched back) | Same, when `AI_PROVIDER=anthropic` | https://status.anthropic.com + Anthropic support email |
| Vercel | Build / deploy / edge errors | Vercel dashboard → Support |
| Neon | DB unavailable / `creds_pending` | Neon dashboard → Support |
| DigitalOcean | Droplet down / network issue | DO dashboard → Support |
| the hosting provider / P21 | Auth or data path failure | the provider contact at Olander |

## AI provider budget cap

Set a monthly spend ceiling in the active provider's console — OpenAI:
**platform.openai.com → Settings → Limits** (set both a monthly budget
and an email alert threshold). Suggest $500/mo to start, alerts at 50% /
80% / 100% to ops email. Prefer auto-recharge with a cap over prepaid
credits: silently running the balance to $0 takes the whole chat down
with "out of credits" errors for every rep. (If switched back to
Anthropic: console → Billing → Usage limits, same idea.)

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
