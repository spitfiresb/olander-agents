# Egress Droplet — Operations Guide

How the DigitalOcean droplet at `<proxy-ip>` is configured, deployed, and operated. This is the box that whitelisted egress for P21 lives on; it also fronts our `/health` endpoint behind Caddy + Let's Encrypt and will eventually host the P21 proxy.

> **Scope:** this doc is about the *box* — Caddy, TLS, install.sh, firewall, rebuild runbook, systemd cheat-sheet. For *what makes P21 specifically reachable* (the hosting provider whitelist, RFC1918 DNS override, SOCKS5 tunneling), see [`P21_Connection.md`](./P21_Connection.md). For integration progress (proxy, tool-calling), see [`P21_Integration.md`](./P21_Integration.md).

## Architecture

```
                         ┌──────────────────────────────────────────┐
   Vercel /api/status    │  droplet (<proxy-ip>)               │
        │                │                                          │
        │ HTTPS GET      │   ┌──────────────────┐                   │
        │ Auth: Bearer…  │   │ Caddy            │                   │
        ├───────────────►│:443  TLS via LE      │                   │
        │                │   │ :80   ACME +     │                   │
        │                │   │       HTTPS rdir │                   │
        │                │   └────────┬─────────┘                   │
        │                │            │ reverse_proxy 127.0.0.1:8088│
        │                │            ▼                             │
        │                │   ┌──────────────────┐                   │
        │                │   │ health-server.py │                   │
        │                │   │  127.0.0.1:8088  │ DynamicUser       │
        │                │   └──────────────────┘                   │
        │                │                                          │
        │                │  iptables INPUT: 22/80/443 only          │
        │                │  iptables NAT:   SNAT to anchor IP       │
        │                └──────────────────────────────────────────┘
```

## SSH access

Key-only auth. Alex's keypair: `~/.ssh/olander_p21`.

```
ssh -i ~/.ssh/olander_p21 root@<proxy-ip>
```

Optional shorthand — add to `~/.ssh/config`:

```
Host olander-p21
    HostName <proxy-ip>
    User root
    IdentityFile ~/.ssh/olander_p21
    IdentitiesOnly yes
```

Then: `ssh olander-p21`.

To grant another dev access, append their public key to `/root/.ssh/authorized_keys`. The droplet is a network hop, not a dev environment — most devs never need to SSH in.

## SNAT (already configured)

DigitalOcean Reserved IPs route inbound traffic only by default. Outbound traffic egresses with the droplet's primary IP (`<droplet-ip>`) unless SNAT rewrites the source. Without SNAT, the hosting provider sees an unwhitelisted source IP and blocks the call.

The rule maps outbound traffic to the anchor IP (`10.46.0.5`); DO's network maps anchor IP ↔ Reserved IP, so external services see `<proxy-ip>`:

```
iptables -t nat -A POSTROUTING -o eth0 -j SNAT --to-source 10.46.0.5
```

Persisted via `iptables-persistent` to `/etc/iptables/rules.v4` — restored automatically on reboot. `provision.sh` re-applies if missing.

Verify from the droplet:

```
curl -s https://ifconfig.me
# expected: <proxy-ip>
```

## TLS + DNS

The droplet exposes its health endpoint (and, in the future, the P21 proxy) via Caddy on `<egress-host>`, terminating TLS with auto-renewing Let's Encrypt certs. The bearer token never traverses plain HTTP, and only ports 22/80/443 are reachable from the internet — port 8088 (the underlying Python health server) binds to loopback and is firewalled regardless.

**Domain:** `<agent-domain>` (Vercel takes the apex; the droplet takes the `egress` subdomain).

### DNS records (at Cloudflare)

| Host | Type | Value | Proxy | TTL |
|---|---|---|---|---|
| `egress` | A | `<proxy-ip>` | **DNS only (gray cloud)** | Auto |

The proxy must be **off** — Cloudflare's orange-cloud proxy intercepts TLS and breaks Caddy's ACME HTTP-01 challenge. Apex (`@`) and `www` records point at Vercel per Vercel's domain-add flow; that's a separate concern.

Verify before running `install.sh`:

```
dig +short <egress-host>
# expected: <proxy-ip>
```

If empty or wrong, propagation hasn't completed; wait 5–60 min. Caddy's ACME HTTP-01 challenge will fail if DNS doesn't point at the droplet.

### Cert renewal

Caddy auto-renews silently every ~60 days (90-day Let's Encrypt certs, renewed at ~30 days remaining). The healthcheck includes a TLS-expiry check; the `/status` page goes amber if a cert is within 7 days of expiry and red within 24 hours — long before the certificate would actually break anything. There is nothing to do on a recurring basis.

## Firewall

`scripts/droplet/firewall.sh` enforces an idempotent INPUT policy. Allowed: `lo`, `ESTABLISHED,RELATED`, and new TCP on 22/80/443. Everything else inbound is dropped. Rules are tagged with a marker comment so re-running flushes managed rules without touching anything else; persisted via `netfilter-persistent`.

> `ufw` was removed when `iptables-persistent` was installed (they conflict). All firewall management goes through `firewall.sh` now.

## Provisioning and health stack

The full droplet bundle lives in `scripts/droplet/`. All idempotent — re-running upgrades in place.

```
scripts/droplet/
├── provision.sh                  # SNAT + /etc/hosts + iptables-persistent + firewall
├── firewall.sh                   # idempotent INPUT chain (22/80/443 only)
├── Caddyfile                     # TLS terminator, reverse-proxies to 127.0.0.1:8088
├── healthcheck.sh                # one-shot check; writes latest.json + appends to log.jsonl
├── health-server.py              # stdlib HTTP server: GET /health (bearer token, loopback bind)
├── olander-healthcheck.{service,timer}  # systemd: run healthcheck every 60s
├── olander-health.service        # systemd: keep health-server.py running (DynamicUser)
└── install.sh                    # orchestrator — provision + Caddy + units, end-to-end TLS verify
```

To set up (or re-converge) a droplet:

```
scp -i ~/.ssh/olander_p21 -r scripts/droplet root@<proxy-ip>:/root/
ssh -i ~/.ssh/olander_p21 root@<proxy-ip> \
  'OLANDER_DOMAIN=<agent-domain> bash /root/droplet/install.sh'
```

`install.sh` requires `OLANDER_DOMAIN`. It checks that `egress.<domain>` resolves to the droplet before doing real work, installs Caddy from the official Cloudsmith repo, places the Caddyfile, and waits up to 90s for Caddy to obtain its Let's Encrypt cert. The end-to-end probe uses the public hostname (not loopback) so a successful run proves the full TLS path works.

The installer prints the health URL and a generated bearer token at the end. Copy them into the Next.js app's environment as `DROPLET_HEALTH_URL` and `DROPLET_HEALTH_TOKEN` — `/status` will start showing live data on the next refresh.

To rotate the token: `rm /etc/olander-health.env` on the droplet and re-run `install.sh`.

## Health log retention

`healthcheck.sh` caps `log.jsonl` at ~90 days of 60-second checks (~32 MB on
disk) so the `/status` page can render a 90-day per-day uptime bar. The
`/health` endpoint reads the log on each request and emits a `daily` array
alongside the existing `uptime` aggregates — no separate roll-up file.

If you change the retention, also update `DAILY_DAYS` in `health-server.py`
to match — they don't have to be identical, but the bar can only display as
many days of real data as the log retains.

## Useful droplet commands

```
systemctl status caddy
systemctl status olander-healthcheck.timer
systemctl status olander-health.service
journalctl -u caddy -f
journalctl -u olander-health.service -f
cat /var/lib/olander-health/latest.json | jq
```

## Rebuilding or replacing the droplet

The Reserved IP, SNAT rule, `/etc/hosts` override, firewall, and Caddy cert are the pieces that make access work end-to-end. To rebuild without breaking access:

1. Spin up the new droplet. Stay in SFO2 — the Reserved IP is region-locked, and changing regions means refiling the whitelist.
2. In **Networking → Reserved IPs**, detach `<proxy-ip>` from the old droplet and reassign it to the new one. (DNS for `<egress-host>` already points at this IP — no DNS change needed.)
3. From your laptop:
   ```
   scp -r scripts/droplet root@<proxy-ip>:/root/
   ssh root@<proxy-ip> 'OLANDER_DOMAIN=<agent-domain> bash /root/droplet/install.sh'
   ```
4. Destroy the old droplet.

The whitelist at the hosting provider does not change. Caddy obtains a fresh Let's Encrypt cert on the new droplet within ~30s. A new bearer token is generated unless you preserve `/etc/olander-health.env` from the old box.

## Notes

- The droplet is an egress hop. The eventual P21 proxy will live behind the same Caddy front door — `<egress-host>/proxy/...` is the natural shape.
- The health server listens on `127.0.0.1:8088` and is reachable only via Caddy's reverse proxy. It exposes aggregate status — no secrets, no upstream payloads.
- `latest.json` is mode 0644 (world-readable) so the DynamicUser server can read it. `log.jsonl` is the same. Token storage in `/etc/olander-health.env` stays mode 0600.
