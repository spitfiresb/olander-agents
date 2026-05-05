# P21 API — Connection Guide

How to reach Olander's P21 (Epicor Prophet 21) REST API. Access is read-only against the dev/play environment.

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

### SSH access
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

### SNAT (already configured)
DigitalOcean Reserved IPs route inbound traffic only by default. Outbound traffic egresses with the droplet's primary IP (`<droplet-ip>`) unless SNAT rewrites the source. Without SNAT, the hosting provider sees an unwhitelisted source IP and blocks the call.

The rule maps outbound traffic to the anchor IP (`10.46.0.5`); DO's network maps anchor IP ↔ Reserved IP, so external services see `<proxy-ip>`:

```
iptables -t nat -A POSTROUTING -o eth0 -j SNAT --to-source 10.46.0.5
```

Persisted via `iptables-persistent` to `/etc/iptables/rules.v4` — restored automatically on reboot.

Verify from the droplet:
```
curl -s https://ifconfig.me
# expected: <proxy-ip>
```
If it returns `<droplet-ip>`, re-run the iptables command above and `netfilter-persistent save`.

## DNS override for `<p21-host>`

Olander's public DNS publishes `<p21-host> → 10.128.2.11` (RFC1918, no public route). The actual public IP is `<p21-host-ip>`. External clients must override DNS locally — the hosting provider confirmed there is no plan to publish a public A record.

On the droplet, this is one line in `/etc/hosts`:
```
<p21-host-ip>  <p21-host>
```

Already installed. Verify:
```
getent hosts <p21-host>
# expected: <p21-host-ip>    <p21-host>

curl -sS -o /dev/null -w 'HTTP %{http_code}\n' 'https://<p21-host>/prophet21/#/login'
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

## Rebuilding or replacing the droplet

The Reserved IP, SNAT rule, and `/etc/hosts` override are the three pieces that make access work end-to-end. To rebuild without breaking access:

1. Spin up the new droplet. Stay in SFO2 — the Reserved IP is region-locked, and changing regions means refiling the whitelist.
2. In **Networking → Reserved IPs**, detach `<proxy-ip>` from the old droplet and reassign it to the new one.
3. SSH into the new droplet and re-run:
   ```
   export DEBIAN_FRONTEND=noninteractive
   ANCHOR_IP=$(curl -s http://169.254.169.254/metadata/v1/interfaces/public/0/anchor_ipv4/address)
   iptables -t nat -A POSTROUTING -o eth0 -j SNAT --to-source "$ANCHOR_IP"
   apt-get update -qq && apt-get install -y iptables-persistent
   netfilter-persistent save
   echo "<p21-host-ip>  <p21-host>" >> /etc/hosts
   curl -s https://ifconfig.me                                              # must print <proxy-ip>
   curl -sS -o /dev/null -w 'HTTP %{http_code}\n' 'https://<p21-host>/prophet21/#/login'  # must print HTTP 200
   ```
4. Destroy the old droplet.

The whitelist at the hosting provider does not change.

## Notes

- `ufw` was removed during the `iptables-persistent` install (they conflict). No firewall is currently active. If one is needed later, add iptables rules directly and `netfilter-persistent save` will persist them.
- The droplet is an egress hop only. The proxy service the chatbot calls will live here, added once the API auth method is known.
