#!/usr/bin/env bash
# Install / re-install the full droplet stack: SNAT base state, firewall,
# health-server, healthcheck timer, Caddy with Let's Encrypt TLS.
#
# Required env var:
#   OLANDER_DOMAIN — apex domain. The droplet binds to egress.<domain>.
#                    DNS for egress.<domain> must already point at this droplet
#                    (<proxy-ip>) before running this script — otherwise
#                    Caddy's ACME HTTP-01 challenge will fail.
#
# Usage (from the droplet, in the directory containing this script):
#   sudo OLANDER_DOMAIN=<agent-domain> bash install.sh
#
# Idempotent: re-running upgrades scripts/units/Caddy in place. Token is
# generated on first install and preserved on subsequent runs. To rotate:
#   sudo rm /etc/olander-health.env && sudo OLANDER_DOMAIN=... bash install.sh
#
# Provision-verification failures (e.g. P21 transiently down) do NOT abort
# install — the healthcheck stack still gets installed so the problem
# becomes observable, not invisible.

set -uo pipefail

log() { printf '[install] %s\n' "$*" >&2; }
warn() { printf '[install] WARN: %s\n' "$*" >&2; }
fail() { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || fail "must run as root"
[[ -n "${OLANDER_DOMAIN:-}" ]] || fail "OLANDER_DOMAIN env var is required (e.g. OLANDER_DOMAIN=<agent-domain>)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_PORT="${HEALTH_PORT:-8088}"
EGRESS_HOST="egress.${OLANDER_DOMAIN}"

# --- DNS sanity check (fast fail before doing real work) ---------------------
log "verifying DNS for ${EGRESS_HOST}"
RESOLVED="$(getent hosts "$EGRESS_HOST" 2>/dev/null | awk '{print $1; exit}')"
EXPECTED_IP="<proxy-ip>"
if [[ "$RESOLVED" != "$EXPECTED_IP" ]]; then
  fail "${EGRESS_HOST} resolves to '${RESOLVED:-<empty>}', expected '$EXPECTED_IP'.
  Add an A record for 'egress' → ${EXPECTED_IP} at your registrar's DNS panel,
  then wait for propagation (\`dig +short ${EGRESS_HOST}\` should match) before re-running."
fi
log "  DNS OK ($RESOLVED)"

# --- Base state (provision: SNAT + /etc/hosts + iptables-persistent + firewall)
export SCRIPT_DIR  # provision.sh re-uses to find firewall.sh
log "running provision.sh to converge droplet base state"
set +e
bash "$SCRIPT_DIR/provision.sh"
prov_rc=$?
set -e
case "$prov_rc" in
  0) log "  base state OK" ;;
  2) warn "provision.sh: convergence done but verification failed."
     warn "Continuing install — the healthcheck stack will surface the issue." ;;
  *) fail "provision.sh failed irrecoverably (exit $prov_rc) — aborting install" ;;
esac

# --- Caddy (TLS termination) -------------------------------------------------
log "ensuring Caddy is installed (from official Cloudsmith repo)"
if ! command -v caddy >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y caddy
else
  log "  caddy already present ($(caddy version | head -1))"
fi

log "placing Caddyfile at /etc/caddy/Caddyfile"
install -m 0644 "$SCRIPT_DIR/Caddyfile" /etc/caddy/Caddyfile

log "writing systemd drop-in with OLANDER_DOMAIN"
install -d -m 0755 /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/override.conf <<EOF
[Service]
Environment=OLANDER_DOMAIN=${OLANDER_DOMAIN}
EOF

log "ensuring /var/log/caddy exists (owned by caddy user)"
install -d -m 0755 -o caddy -g caddy /var/log/caddy

log "validating Caddyfile"
OLANDER_DOMAIN="$OLANDER_DOMAIN" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
  || fail "Caddyfile failed validation"

systemctl daemon-reload
log "restarting caddy"
systemctl enable caddy
systemctl restart caddy

# --- Scripts (healthcheck + health server) -----------------------------------
log "installing scripts to /usr/local/bin"
install -m 0755 "$SCRIPT_DIR/healthcheck.sh"     /usr/local/bin/olander-healthcheck.sh
install -m 0755 "$SCRIPT_DIR/health-server.py"   /usr/local/bin/olander-health-server.py

# --- Data dir ----------------------------------------------------------------
log "ensuring /var/lib/olander-health exists (root:root 0755)"
install -d -m 0755 -o root -g root /var/lib/olander-health

# --- Token / env file --------------------------------------------------------
# Keys: OLANDER_HEALTH_TOKEN, PORT, HOST, OLANDER_DOMAIN. Token persists
# across re-runs; the rest are kept in sync with the current install. Both
# the health-server and healthcheck.sh source this file.
log "ensuring /etc/olander-health.env (root-owned, 0600)"
if [[ ! -f /etc/olander-health.env ]]; then
  TOKEN_VAL="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | cut -c1-40)"
  ( umask 077
    printf 'OLANDER_HEALTH_TOKEN=%s\nPORT=%s\nHOST=127.0.0.1\nOLANDER_DOMAIN=%s\n' \
      "$TOKEN_VAL" "$HEALTH_PORT" "$OLANDER_DOMAIN" > /etc/olander-health.env
  )
  chmod 0600 /etc/olander-health.env
  chown root:root /etc/olander-health.env
  log "  generated new token; bound health-server to 127.0.0.1"
else
  TOKEN_VAL="$(grep -E '^OLANDER_HEALTH_TOKEN=' /etc/olander-health.env | cut -d= -f2-)"
  # Ensure HOST=127.0.0.1 (upgrade path from earlier installs that bound 0.0.0.0).
  if ! grep -qE '^HOST=' /etc/olander-health.env; then
    printf 'HOST=127.0.0.1\n' >> /etc/olander-health.env
    log "  added HOST=127.0.0.1 to existing env file"
  fi
  # Ensure OLANDER_DOMAIN reflects the current install (operator may have
  # changed it via OLANDER_DOMAIN=... bash install.sh).
  if grep -qE '^OLANDER_DOMAIN=' /etc/olander-health.env; then
    sed -i -E "s|^OLANDER_DOMAIN=.*|OLANDER_DOMAIN=${OLANDER_DOMAIN}|" /etc/olander-health.env
  else
    printf 'OLANDER_DOMAIN=%s\n' "$OLANDER_DOMAIN" >> /etc/olander-health.env
  fi
  log "  /etc/olander-health.env preserved (domain synced to ${OLANDER_DOMAIN})"
fi

# --- systemd units -----------------------------------------------------------
log "installing systemd units"
install -m 0644 "$SCRIPT_DIR/olander-healthcheck.service" /etc/systemd/system/
install -m 0644 "$SCRIPT_DIR/olander-healthcheck.timer"   /etc/systemd/system/
install -m 0644 "$SCRIPT_DIR/olander-health.service"      /etc/systemd/system/

systemctl daemon-reload

log "enabling + starting healthcheck timer"
systemctl enable --now olander-healthcheck.timer
systemctl is-active --quiet olander-healthcheck.timer \
  || fail "olander-healthcheck.timer is not active — see 'systemctl status olander-healthcheck.timer'"

log "enabling + starting health server (loopback only)"
systemctl enable olander-health.service
systemctl restart olander-health.service
sleep 1
systemctl is-active --quiet olander-health.service \
  || fail "olander-health.service is not active — see 'journalctl -u olander-health.service -n 50'"

log "running one healthcheck immediately to seed latest.json"
OLANDER_DOMAIN="$OLANDER_DOMAIN" /usr/local/bin/olander-healthcheck.sh \
  || warn "initial healthcheck exited non-zero (will retry on timer)"

# --- Local probe (loopback) --------------------------------------------------
log "verifying health server responds on loopback"
HTTP="$(curl -sS -o /dev/null --max-time 5 -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN_VAL}" \
  "http://127.0.0.1:${HEALTH_PORT}/health" || true)"
if [[ "$HTTP" != "200" ]]; then
  fail "health server probe (loopback) returned HTTP ${HTTP:-<no response>}
  Check: journalctl -u olander-health.service -n 50"
fi
log "  loopback OK (HTTP 200)"

# --- End-to-end probe (TLS via public hostname) ------------------------------
# Wait for Caddy to acquire its Let's Encrypt cert. ACME HTTP-01 typically
# completes within 30s; we allow 90s for slow days.
log "waiting for Caddy to acquire Let's Encrypt cert (up to 90s)"
deadline=$(( $(date +%s) + 90 ))
last_status=""
while [[ $(date +%s) -lt $deadline ]]; do
  # Any 3-digit response code means TLS handshake succeeded.
  last_status="$(curl -sS -o /dev/null --max-time 5 -w '%{http_code}' \
    "https://${EGRESS_HOST}/health" 2>/dev/null || true)"
  [[ "$last_status" =~ ^[0-9]{3}$ ]] && break
  sleep 3
done

if ! [[ "$last_status" =~ ^[0-9]{3}$ ]]; then
  fail "Caddy did not produce a TLS response within 90s.
  Likely causes: (a) DNS not yet pointing at this droplet, (b) port 80/443
  blocked, (c) Let's Encrypt rate limit. Check: journalctl -u caddy -n 100"
fi
log "  TLS handshake OK (HTTP $last_status)"

log "verifying auth through public hostname"
HTTP_AUTH="$(curl -sS -o /dev/null --max-time 5 -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN_VAL}" \
  "https://${EGRESS_HOST}/health" || true)"
if [[ "$HTTP_AUTH" != "200" ]]; then
  fail "Authenticated probe via https://${EGRESS_HOST}/health returned HTTP ${HTTP_AUTH:-<no response>}
  Check: journalctl -u caddy -n 50; journalctl -u olander-health.service -n 50"
fi
log "  end-to-end TLS + auth OK (HTTP 200)"

# --- Done --------------------------------------------------------------------
# The token is printed to the operator's terminal (root session).
# It is NOT logged to journald. Keep this terminal session out of shared
# screen recordings, screenshots, etc.
cat <<EOF

[install] success.

  Health endpoint:  https://${EGRESS_HOST}/health
  Auth header:      Authorization: Bearer ${TOKEN_VAL}

Set these in the Next.js app environment:
  DROPLET_HEALTH_URL=https://${EGRESS_HOST}/health
  DROPLET_HEALTH_TOKEN=${TOKEN_VAL}

Useful droplet commands:
  systemctl status caddy
  systemctl status olander-healthcheck.timer
  systemctl status olander-health.service
  journalctl -u caddy -f
  journalctl -u olander-health.service -f
  cat /var/lib/olander-health/latest.json | jq

EOF
