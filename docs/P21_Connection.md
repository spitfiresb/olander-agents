# P21 API — Connection Guide

How to reach Olander's P21 (Epicor Prophet 21) REST API. Access is read-only against the dev/play environment.

> **Scope:** this doc covers the *upstream-specific* connectivity — what makes P21 reachable at all. For the operational details of the egress droplet (Caddy, install.sh, firewall, rebuild runbook), see [`Droplet.md`](./Droplet.md). For where we are on the broader integration (proxy, chatbot tool-calling), see [`P21_Integration.md`](./P21_Integration.md).

Two pieces are required end-to-end:

1. Egress through the whitelisted DigitalOcean droplet (`<proxy-ip>`).
2. DNS override for `<p21-host>` → `<p21-host-ip>`. The public DNS record points at an RFC1918 address with no public route, so the override is mandatory — there is no path that works on whitelist alone.

## Whitelisted egress

All P21 traffic egresses through a DigitalOcean droplet whose Reserved IP is whitelisted at the hosting provider.

- **Whitelisted IP:** `<proxy-ip>` (DO Reserved IP, region-locked to SFO2)
- **Droplet:** `droplet-1` (DO ID 569016252) in project `first-project`, Ubuntu 24.04 LTS, $4/mo (`s-1vcpu-512mb-10gb`)
- **Other IPs (do not whitelist):**
  - `<droplet-ip>` — droplet's primary public IP
  - `10.46.0.5` — droplet's private anchor IP, used by SNAT

The mechanics of how SNAT rewrites outbound traffic so the hosting provider sees the Reserved IP, plus the iptables rule and persistence, live in [`Droplet.md`](./Droplet.md#snat-already-configured). The whitelist only ever needs to know about `<proxy-ip>`.

## DNS override for `<p21-host>`

Olander's public DNS publishes `<p21-host> → 10.128.2.11` (RFC1918, no public route). The actual public IP is `<p21-host-ip>`. External clients must override DNS locally — the hosting provider confirmed there is no plan to publish a public A record.

On the droplet, this is one line in `/etc/hosts`:

```
<p21-host-ip>  <p21-host>
```

Already installed by `scripts/droplet/provision.sh` and verified by the healthcheck every 60s. To verify manually from the droplet:

```
getent hosts <p21-host>
# expected: <p21-host-ip>    <p21-host>

curl -sS -o /dev/null -w 'HTTP %{http_code}\n' 'https://<p21-host>/prophet21/'
# expected: HTTP 200
```

Anything running on the droplet (curl, the future proxy service) inherits this override. **Off-droplet** clients (a laptop, a Chrome demo over the SOCKS5 tunnel) do their own DNS and need their own override — see below.

## Browser access via SOCKS5 tunnel

For ad-hoc human access (e.g., logging into the P21 web UI to inspect schema), tunnel a browser through the droplet so traffic egresses with the whitelisted IP:

```
ssh -i ~/.ssh/olander_p21 -D 127.0.0.1:1080 -N -f root@<proxy-ip>
```

Launch an isolated Chrome window that uses the tunnel **and** overrides DNS for the P21 hostname (otherwise Chrome resolves it itself and gets the private IP):

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="/tmp/chrome-olander" \
  --proxy-server="socks5://127.0.0.1:1080" \
  --host-resolver-rules="MAP <p21-host> <p21-host-ip>" \
  https://<p21-host>/prophet21/#/login
```

Tear down when done: `pkill -f "ssh.*-D 127.0.0.1:1080"`.

## Manually exploring the API from the droplet

While we wait on auth credentials and endpoint docs from the provider contact (see [`P21_Integration.md`](./P21_Integration.md)), the droplet itself is the simplest way to poke at P21 endpoints — it inherits both the SNAT egress and the `/etc/hosts` override automatically:

```
ssh -i ~/.ssh/olander_p21 root@<proxy-ip>
curl -sS 'https://<p21-host>/<endpoint>' -H 'Authorization: <when we have it>'
```
