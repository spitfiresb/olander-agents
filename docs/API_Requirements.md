# P21 API Access Requirements

## Context
Olander is granting read-only access to their Epicor Prophet 21 ERP via the P21 REST API for AI application development. Database is hosted by the hosting provider. Access begins on a development/play environment; production access follows once the application is validated.

## Access Model
- **Environment:** P21 development database only (no production data in MVP).
- **Permissions:** Read-only.
- **Tenancy:** All data and processing must remain within Olander's tenant — no external sharing.
- **User account:** JOlander will provision a P21 user to log into the P21 client and inspect schema/fields.
- **Future:** Role-based access tiers will gate sensitive fields per user level once the app moves toward production.

## Network / IP Whitelisting
the hosting provider whitelists static IPs at multiple security layers. The developer machines are on CGNAT with dynamic IPs, so a static egress is required.

- **Solution:** DigitalOcean droplet (~$4/month, smallest tier) with a reserved/static IP, used as the egress point for all P21 API calls during development.
- **Production:** The deployed tool will use a static egress proxy (likely the same droplet pattern or AWS equivalent) — final IP to be confirmed before prod cutover.
- **Deliverable to the provider contact:** One static IPv4 address to forward to the hosting provider for whitelisting.

## What We Need From Olander
1. Static IP whitelisted at the hosting provider (we provide the IP).
2. P21 user credentials for the dev environment.
3. P21 API documentation (the provider contact has located this).
4. Kickoff meeting: P21 walkthrough covering relevant modules, fields, and API endpoints.

## What We Provide
1. Static IPv4 from the DigitalOcean droplet — **delivered 2026-05-04: `<proxy-ip>`**.
2. Confirmation of dev contacts: Alex Rankine, Zain Saeed, James O'Connor.

## Egress Droplet — Operational Runbook

### Droplet
- **Name:** `droplet-1` (DO ID 569016252) in project `first-project`
- **Region / image:** SFO2, Ubuntu 24.04 LTS x64
- **Plan:** Basic Regular `s-1vcpu-512mb-10gb` — $4/mo (1 vCPU, 512 MB RAM, 10 GB SSD, 500 GB transfer)
- **Created:** 2026-05-04

### IPs
- **`<proxy-ip>`** — DigitalOcean Reserved IP. **This is the IP given to the hosting provider for whitelisting.** Decoupled from the droplet — survives rebuilds when reattached.
- `<droplet-ip>` — droplet's primary public IP. Do **not** give this to the hosting provider. Only relevant during initial setup before SNAT was configured.
- `10.46.0.5` — droplet's anchor IP (private). Used by SNAT to route outbound traffic via the Reserved IP.

### SSH access
Key-only auth (password auth still enabled but unused; consider disabling if hardening is needed). Alex's keypair lives at `~/.ssh/olander_p21` on his Mac.

Direct connection:
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

To grant another dev SSH access (e.g., for log debugging), append their public key to `/root/.ssh/authorized_keys` on the droplet. Per-user accounts not set up — droplet is a network hop, not a dev environment, so most devs never need to SSH in.

### Why SNAT is configured
DigitalOcean Reserved IPs route inbound traffic only by default. **Outbound traffic egresses with the droplet's primary IP (`<droplet-ip>`) as source unless SNAT is configured.** Without SNAT, the hosting provider would see calls from the primary IP and block them despite the Reserved IP being whitelisted.

The fix: SNAT outbound traffic to the droplet's anchor IP (`10.46.0.5`). DO's network maps the anchor IP ↔ Reserved IP, so external services see `<proxy-ip>` as the source.

The rule (already installed and persisted via `iptables-persistent`):
```
iptables -t nat -A POSTROUTING -o eth0 -j SNAT --to-source 10.46.0.5
```

Saved to `/etc/iptables/rules.v4` — restored automatically on reboot.

### Verify SNAT is working
From the droplet:
```
curl -s https://ifconfig.me
```
Must return `<proxy-ip>`. If it returns `<droplet-ip>`, SNAT is not active — re-run the iptables command above and `netfilter-persistent save`.

### Rebuilding or replacing the droplet
The Reserved IP and the SNAT rule are the two pieces that make the whitelist permanent. To rebuild without breaking the hosting provider access:

1. Spin up the new droplet (any region — but the Reserved IP is region-locked to SFO2, so stay in SFO2 unless you're prepared to refile a whitelist).
2. In **Networking → Reserved IPs**, detach `<proxy-ip>` from the old droplet and reassign it to the new one.
3. SSH into the new droplet and re-run:
   ```
   export DEBIAN_FRONTEND=noninteractive
   ANCHOR_IP=$(curl -s http://169.254.169.254/metadata/v1/interfaces/public/0/anchor_ipv4/address)
   iptables -t nat -A POSTROUTING -o eth0 -j SNAT --to-source "$ANCHOR_IP"
   apt-get update -qq && apt-get install -y iptables-persistent
   netfilter-persistent save
   curl -s https://ifconfig.me   # must print <proxy-ip>
   ```
4. Destroy the old droplet.

The whitelist at the hosting provider does not change.

### Notes
- `ufw` was removed during the `iptables-persistent` install (they conflict). No firewall is currently active. If a firewall is needed later, add iptables rules directly and `netfilter-persistent save` will persist them.
- The droplet is intended only as an egress hop. The proxy service that exposes P21 access to the chatbot will be added once the API auth method is known.

## Open Items
- Confirm API auth method (token, basic auth, OAuth) once the provider contact shares docs.
- Define which P21 tables/endpoints are in scope for the MVP before requesting broader access.
- Build a small proxy service on the droplet that the chatbot can call (depends on API docs + auth method).
