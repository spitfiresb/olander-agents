#!/usr/bin/env bash
# Idempotent setup for the P21 egress droplet.
#
# Three pieces of state must be true for P21 access to work end-to-end:
#   1. SNAT rewrites outbound traffic to the anchor IP so external services
#      see the whitelisted Reserved IP (<proxy-ip>) instead of the
#      droplet's primary public IP.
#   2. /etc/hosts overrides <p21-host> → <p21-host-ip> because the
#      public DNS record points at an unroutable RFC1918 address.
#   3. iptables-persistent saves the SNAT rule across reboots.
#
# Run as root on the droplet (or to re-converge an existing one):
#   bash provision.sh
#
# Exit codes:
#   0 — converged and verified
#   1 — could not converge (would-have-been-destructive: e.g. not a DO droplet)
#   2 — converged but verification failed (SNAT didn't take, or P21 unreachable);
#       caller (install.sh) treats this as non-fatal so the healthcheck stack
#       still gets installed and can surface the problem.

set -uo pipefail

EXPECTED_EGRESS_IP="<proxy-ip>"
P21_HOST="<p21-host>"
P21_REAL_IP="<p21-host-ip>"
P21_PROBE_URL="https://${P21_HOST}/prophet21/"

log() { printf '[provision] %s\n' "$*" >&2; }
warn() { printf '[provision] WARN: %s\n' "$*" >&2; }
fail() { printf '[provision] ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || fail "must run as root"

# --- Detect primary interface from the default route -------------------------
# Don't assume eth0 — modern Ubuntu may use predictable names (ens3, etc.).
# Adding a SNAT rule on the wrong interface silently does nothing AND adding
# it again on the right interface would create duplicates on re-runs.
PRIMARY_IFACE="$(ip -4 route show default 0.0.0.0/0 | awk '/^default/ {for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}')"
[[ -n "$PRIMARY_IFACE" ]] || fail "could not determine primary network interface from 'ip route'"
log "primary interface: $PRIMARY_IFACE"

# --- Anchor IP from DigitalOcean metadata -----------------------------------
log "fetching anchor IP from droplet metadata"
ANCHOR_IP="$(curl -sf --max-time 5 http://169.254.169.254/metadata/v1/interfaces/public/0/anchor_ipv4/address || true)"
[[ -n "$ANCHOR_IP" ]] || fail "could not read anchor IP — is this a DigitalOcean droplet?"
log "anchor IP: $ANCHOR_IP"

# --- SNAT rule ---------------------------------------------------------------
log "ensuring SNAT rule on $PRIMARY_IFACE"
if iptables -t nat -C POSTROUTING -o "$PRIMARY_IFACE" -j SNAT --to-source "$ANCHOR_IP" 2>/dev/null; then
  log "  SNAT rule already present — skipping"
else
  iptables -t nat -A POSTROUTING -o "$PRIMARY_IFACE" -j SNAT --to-source "$ANCHOR_IP"
  log "  SNAT rule added"
fi

# --- iptables-persistent -----------------------------------------------------
log "ensuring iptables-persistent is installed"
if ! dpkg -s iptables-persistent >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections
  echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections
  apt-get update -qq
  apt-get install -y iptables-persistent
fi

log "saving iptables rules to /etc/iptables/rules.v4"
netfilter-persistent save >/dev/null

# --- INPUT firewall policy ---------------------------------------------------
# Locks the droplet down to SSH + Caddy (80/443). Idempotent and safe to
# re-run. Has to come AFTER iptables-persistent install so the saved rules
# include the firewall policy.
SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
log "applying INPUT firewall policy"
bash "$SCRIPT_DIR/firewall.sh"

# --- /etc/hosts override -----------------------------------------------------
# Only consider the line "present" if it's a clean leading-anchored entry.
# This avoids both false negatives (where we'd append a duplicate) and false
# positives (where a weird embedded match would mask a stale entry).
log "ensuring /etc/hosts override for ${P21_HOST}"
if grep -qE "^[[:space:]]*${P21_REAL_IP}[[:space:]]+${P21_HOST}([[:space:]]|\$|#)" /etc/hosts; then
  log "  /etc/hosts entry already present — skipping"
else
  # Take a single timestamped backup (don't keep clobbering the same .bak).
  cp -n /etc/hosts "/etc/hosts.bak.$(date -u +%Y%m%d%H%M%S)" || true
  # Drop any stale entry for the hostname in-place (no .bak).
  sed -i -E "/[[:space:]]${P21_HOST}([[:space:]]|\$|#)/d" /etc/hosts
  printf '%s  %s\n' "$P21_REAL_IP" "$P21_HOST" >> /etc/hosts
  log "  /etc/hosts entry added"
fi

# --- Verification ------------------------------------------------------------
# Convergence is done. Verification below is informational: a transient flake
# (ifconfig.me down, P21 maintenance window) shouldn't prevent the healthcheck
# stack from being installed — that stack is what tells you about these
# failures going forward. Caller (install.sh) treats exit code 2 as non-fatal.

verify_failed=0

log "verifying egress IP via ifconfig.me"
EGRESS_IP="$(curl -sf --max-time 10 https://ifconfig.me 2>/dev/null || true)"
if [[ "$EGRESS_IP" == "$EXPECTED_EGRESS_IP" ]]; then
  log "  egress IP OK ($EGRESS_IP)"
else
  warn "egress IP is '${EGRESS_IP:-<empty>}', expected '$EXPECTED_EGRESS_IP'"
  verify_failed=1
fi

log "verifying P21 reachability"
HTTP_STATUS="$(curl -sS -o /dev/null --max-time 15 -w '%{http_code}' "$P21_PROBE_URL" 2>/dev/null || true)"
if [[ "$HTTP_STATUS" =~ ^[23][0-9][0-9]$ ]]; then
  log "  P21 reachable (HTTP $HTTP_STATUS)"
else
  warn "P21 probe returned HTTP ${HTTP_STATUS:-<no response>} (expected 2xx/3xx)"
  verify_failed=1
fi

if (( verify_failed )); then
  warn "convergence done but verification failed — see warnings above"
  exit 2
fi

log "done — droplet is provisioned and verified"
