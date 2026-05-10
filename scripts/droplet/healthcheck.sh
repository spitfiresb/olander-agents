#!/usr/bin/env bash
# Run the three P21-egress checks and emit a single JSON record.
#
# Side effects:
#   - Overwrites /var/lib/olander-health/latest.json (current state).
#   - Appends one JSON line to /var/lib/olander-health/log.jsonl (history).
#
# Designed to run every 60s via systemd timer (see olander-healthcheck.timer).
# A run never silently disappears — every outcome (pass, fail, even script
# crash) writes an observable record. We want a continuous log even when
# something is broken.

set -uo pipefail

EXPECTED_EGRESS_IP="${EXPECTED_EGRESS_IP:-<proxy-ip>}"
P21_HOST="${P21_HOST:-<p21-host>}"
P21_EXPECTED_DNS="${P21_EXPECTED_DNS:-<p21-host-ip>}"
P21_PROBE_URL="${P21_PROBE_URL:-https://${P21_HOST}/prophet21/}"
# OLANDER_DOMAIN is optional. If set, we add a TLS-expiry check for
# egress.<domain> to the JSON record. If unset, the field is omitted.
OLANDER_DOMAIN="${OLANDER_DOMAIN:-}"
DATA_DIR="${DATA_DIR:-/var/lib/olander-health}"
LATEST_FILE="${DATA_DIR}/latest.json"
LOG_FILE="${DATA_DIR}/log.jsonl"
# Cap log to ~7 days of 60s checks (10080 lines). Trim if it grows past 11000.
LOG_MAX_LINES=11000
LOG_TRIM_TO=10080
# TLS-expiry thresholds (hours). >warn = ok; warn..crit = degraded; <crit = down.
TLS_WARN_HOURS=168   # 7 days
TLS_CRIT_HOURS=24    # 1 day

mkdir -p "$DATA_DIR" || { printf 'healthcheck: cannot create %s\n' "$DATA_DIR" >&2; exit 10; }
[[ -w "$DATA_DIR" ]] || { printf 'healthcheck: %s is not writable\n' "$DATA_DIR" >&2; exit 11; }

# Track tmp files so the EXIT trap can clean them up on partial failure.
tmp=""

# On any unexpected exit, emit a "down" record so the dashboard doesn't see
# stale data and assume "still ok." Best-effort: if we can't write, oh well.
write_error_record() {
  local code="$1"
  local err_record
  err_record="$(printf '{"checked_at":"%s","overall":"down","error":"healthcheck.sh exited %d at line %s"}' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$code" "${BASH_LINENO[0]:-?}")"
  printf '%s\n' "$err_record" > "$LATEST_FILE" 2>/dev/null || true
  printf '%s\n' "$err_record" >> "$LOG_FILE" 2>/dev/null || true
}

on_exit() {
  local code=$?
  [[ -n "$tmp" && -e "$tmp" ]] && rm -f "$tmp"
  if (( code != 0 )); then
    write_error_record "$code"
  fi
}
trap on_exit EXIT

now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Portable millisecond clock (BSD `date` lacks %N; python3 ships on macOS + Ubuntu).
now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

# --- Check 1: egress IP -------------------------------------------------------
egress_latency=0
egress_start="$(now_ms)"
egress_ip_raw="$(curl -sf --max-time 8 https://ifconfig.me 2>/dev/null || true)"
egress_end="$(now_ms)"
[[ -n "$egress_end" && -n "$egress_start" ]] && egress_latency=$(( egress_end - egress_start ))
# Sanitize: keep only chars valid in IPv4/IPv6 (digits, dots, colons, hex).
# If ifconfig.me returns HTML or anything weird, this strips it to safe bytes
# and the `==` check below correctly flags it as a mismatch.
egress_ip="${egress_ip_raw//[^0-9a-fA-F.:]/}"
if [[ "$egress_ip" == "$EXPECTED_EGRESS_IP" ]]; then
  egress_ok=true
else
  egress_ok=false
fi

# --- Check 2: DNS override ---------------------------------------------------
# `getent` lives on Linux; fall back to /etc/hosts on macOS for local smoke tests.
if command -v getent >/dev/null 2>&1; then
  resolved_ip_raw="$(getent hosts "$P21_HOST" 2>/dev/null | awk '{print $1; exit}')"
else
  # DEV-ONLY fallback for local testing on macOS.
  resolved_ip_raw="$(awk -v h="$P21_HOST" '$0 !~ /^[[:space:]]*#/ { for (i=2;i<=NF;i++) if ($i==h) { print $1; exit } }' /etc/hosts)"
fi
resolved_ip="${resolved_ip_raw//[^0-9a-fA-F.:]/}"
if [[ "$resolved_ip" == "$P21_EXPECTED_DNS" ]]; then
  dns_ok=true
else
  dns_ok=false
fi

# --- Check 3: P21 reachability -----------------------------------------------
p21_latency=0
p21_start="$(now_ms)"
p21_status_raw="$(curl -sS -o /dev/null --max-time 12 -w '%{http_code}' "$P21_PROBE_URL" 2>/dev/null || true)"
p21_end="$(now_ms)"
[[ -n "$p21_end" && -n "$p21_start" ]] && p21_latency=$(( p21_end - p21_start ))
# Only accept 3-digit numeric HTTP statuses; anything else becomes 0.
if [[ "$p21_status_raw" =~ ^[0-9]{3}$ ]]; then
  p21_status="$p21_status_raw"
else
  p21_status="0"
fi
if [[ "$p21_status" =~ ^[23][0-9][0-9]$ ]]; then
  p21_ok=true
else
  p21_ok=false
fi

# --- Check 4: TLS cert expiry (only if OLANDER_DOMAIN is set) ----------------
# Caddy auto-renews well before expiration, but if anything wedges (firewall
# regression, ACME outage, port 80 blocked), the cert quietly approaches
# expiry. This check surfaces that as degraded with plenty of runway.
tls_present=false
tls_ok=false
tls_hours=0
tls_expires_at=""
if [[ -n "$OLANDER_DOMAIN" ]]; then
  tls_host="egress.${OLANDER_DOMAIN}"
  # Use Python's ssl module: built-in timeout, no openssl pipeline parsing.
  tls_result="$(OLANDER_TLS_HOST="$tls_host" python3 -c '
import os, socket, ssl, sys
from datetime import datetime, timezone
host = os.environ["OLANDER_TLS_HOST"]
try:
    ctx = ssl.create_default_context()
    with socket.create_connection((host, 443), timeout=8) as sock:
        with ctx.wrap_socket(sock, server_hostname=host) as ssock:
            cert = ssock.getpeercert()
    not_after = datetime.strptime(cert["notAfter"], "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
    hours = int((not_after - datetime.now(tz=timezone.utc)).total_seconds() / 3600)
    iso = not_after.strftime("%Y-%m-%dT%H:%M:%SZ")
    print("{}|{}".format(hours, iso))
except Exception as e:
    sys.stderr.write(f"tls check failed: {e}\n")
    sys.exit(1)
' 2>/dev/null || true)"
  if [[ -n "$tls_result" && "$tls_result" == *"|"* ]]; then
    tls_present=true
    tls_hours="${tls_result%%|*}"
    tls_expires_at="${tls_result##*|}"
    [[ "$tls_hours" =~ ^-?[0-9]+$ ]] || tls_hours=0
    if (( tls_hours > TLS_WARN_HOURS )); then
      tls_ok=true
    fi
  fi
fi

# --- Aggregate ---------------------------------------------------------------
if [[ "$egress_ok" == "true" && "$dns_ok" == "true" && "$p21_ok" == "true" ]]; then
  overall="ok"
elif [[ "$p21_ok" == "true" ]]; then
  # P21 still answers but one of the underlying invariants is wrong — drift,
  # not outage. Surface as degraded so we can fix it before it becomes one.
  overall="degraded"
else
  overall="down"
fi
# Cert expiry never makes overall=down (the chatbot still works), but it can
# push from ok → degraded so the dashboard turns amber while there's runway.
if [[ "$tls_present" == "true" && "$tls_ok" == "false" && "$overall" == "ok" ]]; then
  overall="degraded"
fi

# --- Build JSON via python (handles all escaping) ----------------------------
record="$(
  CHECKED_AT="$now_iso" \
  OVERALL="$overall" \
  EGRESS_OK="$egress_ok" EGRESS_VALUE="$egress_ip" EGRESS_EXPECTED="$EXPECTED_EGRESS_IP" EGRESS_LATENCY="$egress_latency" \
  DNS_OK="$dns_ok" DNS_VALUE="$resolved_ip" DNS_EXPECTED="$P21_EXPECTED_DNS" \
  P21_OK="$p21_ok" P21_STATUS="$p21_status" P21_LATENCY="$p21_latency" P21_URL="$P21_PROBE_URL" \
  TLS_PRESENT="$tls_present" TLS_OK="$tls_ok" TLS_HOURS="$tls_hours" TLS_EXPIRES_AT="$tls_expires_at" \
  python3 -c '
import json, os
e = os.environ
def b(k): return e[k] == "true"
def i(k):
  try: return int(e[k])
  except (ValueError, KeyError): return 0
checks = {
  "egress_ip":    {"ok": b("EGRESS_OK"), "value": e["EGRESS_VALUE"], "expected": e["EGRESS_EXPECTED"], "latency_ms": i("EGRESS_LATENCY")},
  "dns_override": {"ok": b("DNS_OK"),    "value": e["DNS_VALUE"],    "expected": e["DNS_EXPECTED"]},
  "p21_reachable":{"ok": b("P21_OK"),    "http_status": i("P21_STATUS"), "latency_ms": i("P21_LATENCY"), "url": e["P21_URL"]},
}
if b("TLS_PRESENT"):
  checks["tls_cert"] = {"ok": b("TLS_OK"), "hours_until_expiry": i("TLS_HOURS"), "expires_at": e["TLS_EXPIRES_AT"]}
print(json.dumps({
  "checked_at": e["CHECKED_AT"],
  "overall":    e["OVERALL"],
  "checks":     checks,
}, separators=(",", ":")))
'
)"

# Defensive: if python emitted nothing, write_error_record will fire via trap.
[[ -n "$record" ]] || exit 3

# Write atomically: temp file + rename.
# mktemp creates files mode 0600 by default (its security-paranoid default).
# We need 0644 because the health server runs as a DynamicUser system account
# that needs to read this file. The contents have no secrets — just status JSON.
tmp="$(mktemp "${LATEST_FILE}.XXXXXX")" || exit 12
printf '%s\n' "$record" > "$tmp" || exit 13
chmod 0644 "$tmp" || exit 16
mv "$tmp" "$LATEST_FILE" || exit 14
tmp=""  # ownership transferred; trap won't try to delete

printf '%s\n' "$record" >> "$LOG_FILE" || exit 15

# Trim log if it has grown too large (cheap: count lines, tail-truncate).
line_count="$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)"
if (( line_count > LOG_MAX_LINES )); then
  tail -n "$LOG_TRIM_TO" "$LOG_FILE" > "${LOG_FILE}.trim" && mv "${LOG_FILE}.trim" "$LOG_FILE"
fi
