#!/usr/bin/env bash
# Apply the droplet's INPUT firewall policy. Idempotent: re-running the
# script removes any rules tagged with our marker comment and re-adds them
# from scratch, so we never accumulate duplicates.
#
# Policy:
#   - ACCEPT loopback
#   - ACCEPT ESTABLISHED,RELATED  (return traffic for outbound calls)
#   - ACCEPT new TCP on 22 (SSH), 80 (Caddy ACME + redirect), 443 (Caddy TLS)
#   - DROP   everything else inbound
#
# The NAT table (POSTROUTING SNAT for P21 egress) is NOT touched — that's
# managed by provision.sh and is independent of inbound filtering.

set -euo pipefail

MARKER="olander-firewall-managed"
LOG_PFX="[firewall]"

log() { printf '%s %s\n' "$LOG_PFX" "$*" >&2; }
fail() { printf '%s ERROR: %s\n' "$LOG_PFX" "$*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || fail "must run as root"
command -v iptables >/dev/null || fail "iptables not installed"

# --- Remove any prior rules we tagged with the marker ------------------------
# Safe idempotent flush: list rules, find marker matches, delete by line.
# Iterate by re-listing each pass because line numbers shift after deletion.
log "removing any prior managed rules"
while iptables -nL INPUT --line-numbers | grep -q "$MARKER"; do
  line="$(iptables -nL INPUT --line-numbers | awk -v m="$MARKER" '$0 ~ m {print $1; exit}')"
  [[ -n "$line" ]] || break
  iptables -D INPUT "$line"
done

# --- Re-add rules in the right order ----------------------------------------
log "applying INPUT policy"
iptables -A INPUT -i lo                                  -m comment --comment "$MARKER" -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment "$MARKER" -j ACCEPT
iptables -A INPUT -p tcp --dport 22  -m conntrack --ctstate NEW -m comment --comment "$MARKER" -j ACCEPT
iptables -A INPUT -p tcp --dport 80  -m conntrack --ctstate NEW -m comment --comment "$MARKER" -j ACCEPT
iptables -A INPUT -p tcp --dport 443 -m conntrack --ctstate NEW -m comment --comment "$MARKER" -j ACCEPT
iptables -A INPUT -m comment --comment "$MARKER" -j DROP

log "saving rules to /etc/iptables/rules.v4"
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save >/dev/null
else
  log "WARN: netfilter-persistent not installed — rules will not survive reboot"
fi

log "done. Active INPUT chain:"
iptables -nL INPUT --line-numbers | sed "s/^/$LOG_PFX   /" >&2
