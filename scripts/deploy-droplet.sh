#!/usr/bin/env bash
# One-shot deploy of the droplet Layer-2 proxy from this laptop.
#
# What it does (idempotent — safe to re-run any time):
#   1. Reads P21_USERNAME / P21_PASSWORD / P21_BASE_URL from .env.local.
#   2. scp's scripts/droplet/* to /root/droplet/ on the droplet.
#   3. Runs install.sh on the droplet (creates env file + token on first run,
#      preserves them on re-runs; converges systemd units; restarts services).
#   4. Merges P21 credentials into /etc/olander-proxy.env without ever putting
#      the password on a command line (piped via stdin into a small python
#      helper on the droplet).
#   5. Restarts olander-proxy.service and probes /proxy/healthz on loopback.
#
# Usage (from laptop, repo root):
#   ./scripts/deploy-droplet.sh
#
# Optional overrides (you almost never need these):
#   DROPLET_HOST=<proxy-ip>   DROPLET_USER=root
#   SSH_KEY=~/.ssh/olander_p21     OLANDER_DOMAIN=<agent-domain>

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env.local"

DROPLET_HOST="${DROPLET_HOST:-<proxy-ip>}"
DROPLET_USER="${DROPLET_USER:-root}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/olander_p21}"
OLANDER_DOMAIN="${OLANDER_DOMAIN:-<agent-domain>}"

log()  { printf '[deploy] %s\n' "$*" >&2; }
warn() { printf '[deploy] WARN: %s\n' "$*" >&2; }
fail() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

[[ -f "$ENV_FILE" ]]  || fail ".env.local not found at $ENV_FILE"
[[ -f "$SSH_KEY"  ]]  || fail "SSH key not found at $SSH_KEY (override with SSH_KEY=...)"

SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "${DROPLET_USER}@${DROPLET_HOST}")
SCP=(scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

# --- 1. Extract the three P21 env values from .env.local --------------------
# dotenv quirks (quoted values, escapes, `#` inside quotes) are easier to
# handle in Python than in bash; we shell out once and emit shell-safe lines.
read_dotenv_py() {
  python3 - "$ENV_FILE" "$@" <<'PY'
import os, sys, re
path = sys.argv[1]
keys = set(sys.argv[2:])
out = {}
with open(path) as f:
    for raw in f:
        line = raw.lstrip()
        if not line or line.startswith("#"): continue
        if "=" not in line: continue
        k, v = line.split("=", 1)
        k = k.strip()
        if k not in keys: continue
        v = v.rstrip("\n").rstrip()
        # Strip matching quotes if present.
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
            v = v[1:-1]
        out[k] = v
for k in keys:
    if k in out:
        print(f"{k}={out[k]}")
PY
}

set +o pipefail
ENV_LINES="$(read_dotenv_py P21_USERNAME P21_PASSWORD P21_BASE_URL)"
set -o pipefail

P21_USERNAME="$(awk -F= '/^P21_USERNAME=/ {sub(/^P21_USERNAME=/,""); print; exit}' <<<"$ENV_LINES")"
P21_PASSWORD="$(awk -F= '/^P21_PASSWORD=/ {sub(/^P21_PASSWORD=/,""); print; exit}' <<<"$ENV_LINES")"
P21_BASE_URL="$(awk -F= '/^P21_BASE_URL=/ {sub(/^P21_BASE_URL=/,""); print; exit}' <<<"$ENV_LINES")"
P21_BASE_URL="${P21_BASE_URL:-https://<p21-host>}"

[[ -n "$P21_USERNAME" ]] || fail "P21_USERNAME missing from .env.local"
[[ -n "$P21_PASSWORD" ]] || fail "P21_PASSWORD missing from .env.local"
log "loaded P21 creds from .env.local (user=$P21_USERNAME, password=<${#P21_PASSWORD} chars>)"

# --- 2. Push scripts/droplet/* to /root/droplet/ ----------------------------
log "scp'ing scripts/droplet/ to ${DROPLET_USER}@${DROPLET_HOST}:/root/droplet/"
"${SSH[@]}" 'mkdir -p /root/droplet' \
  || fail "ssh failed — check key, host, network (and that the droplet is up)"
"${SCP[@]}" -r "${REPO_ROOT}/scripts/droplet/." "${DROPLET_USER}@${DROPLET_HOST}:/root/droplet/" \
  || fail "scp failed"

# --- 3. Run install.sh on the droplet ---------------------------------------
log "running install.sh on droplet (OLANDER_DOMAIN=$OLANDER_DOMAIN) — this may take a moment"
if ! "${SSH[@]}" "OLANDER_DOMAIN='${OLANDER_DOMAIN}' bash /root/droplet/install.sh"; then
  fail "install.sh failed on the droplet — see the output above and ssh in to debug"
fi

# --- 4. Merge P21_USERNAME / P21_PASSWORD into /etc/olander-proxy.env -------
# Two SSH calls so we can keep the password on stdin (never on a command
# line, never in shell history). First call writes the merge helper to a
# temp file via heredoc; second call pipes the payload into it.
log "merging P21 credentials into /etc/olander-proxy.env (root, 0600)"

"${SSH[@]}" 'cat > /root/.olander-merge-env.py && chmod 0700 /root/.olander-merge-env.py' <<'MERGE_PY' \
  || fail "failed to upload env-merge helper to droplet"
import os, sys, tempfile
ENV_PATH = "/etc/olander-proxy.env"
incoming = {}
for line in sys.stdin.read().splitlines():
    if not line or "=" not in line: continue
    k, v = line.split("=", 1)
    incoming[k] = v
if not incoming:
    sys.stderr.write("merge-env: no key=value pairs received on stdin\n")
    sys.exit(2)
existing = {}
order = []
try:
    with open(ENV_PATH) as f:
        for raw in f:
            line = raw.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                order.append(("comment", line))
            elif "=" in line:
                k = line.split("=", 1)[0]
                order.append(("kv", k))
                existing[k] = line
except FileNotFoundError:
    pass
for k, v in incoming.items():
    existing[k] = "{}={}".format(k, v)
    if not any(typ == "kv" and key == k for typ, key in order):
        order.append(("kv", k))
out_lines = []
seen = set()
for typ, val in order:
    if typ == "comment":
        out_lines.append(val)
    else:
        if val in seen: continue
        seen.add(val)
        out_lines.append(existing[val])
fd, tmp = tempfile.mkstemp(prefix=".olander-proxy.env.", dir="/etc")
os.write(fd, ("\n".join(out_lines) + "\n").encode("utf-8"))
os.close(fd)
os.chmod(tmp, 0o600)
os.chown(tmp, 0, 0)
os.replace(tmp, ENV_PATH)
print("ok wrote {} keys".format(len(incoming)))
MERGE_PY

P21_PAYLOAD="$(printf 'P21_USERNAME=%s\nP21_PASSWORD=%s\nP21_BASE_URL=%s\n' \
  "$P21_USERNAME" "$P21_PASSWORD" "$P21_BASE_URL")"

if ! printf '%s' "$P21_PAYLOAD" | "${SSH[@]}" 'python3 /root/.olander-merge-env.py; rc=$?; rm -f /root/.olander-merge-env.py; exit $rc'; then
  fail "failed to merge P21 creds into /etc/olander-proxy.env"
fi

# --- 5. Restart and probe ---------------------------------------------------
log "restarting olander-proxy.service"
"${SSH[@]}" 'systemctl restart olander-proxy.service && sleep 1 && systemctl is-active olander-proxy.service' \
  || fail "olander-proxy.service did not come back up — journalctl -u olander-proxy.service -n 50"

log "probing /proxy/healthz on loopback"
HEALTHZ_JSON="$("${SSH[@]}" "PROXY_TOKEN=\$(grep -E '^OLANDER_PROXY_TOKEN=' /etc/olander-proxy.env | cut -d= -f2-); \
  curl -fsS --max-time 5 -H \"Authorization: Bearer \$PROXY_TOKEN\" http://127.0.0.1:8089/proxy/healthz" \
  2>/dev/null || true)"
if [[ -z "$HEALTHZ_JSON" ]]; then
  fail "proxy /proxy/healthz did not respond on loopback — check journalctl -u olander-proxy.service"
fi
log "  healthz: $HEALTHZ_JSON"
if ! grep -q '"creds_present":true' <<<"$HEALTHZ_JSON"; then
  warn "creds_present is not true — P21 creds didn't land in /etc/olander-proxy.env."
  warn "  Inspect with: ssh -i $SSH_KEY ${DROPLET_USER}@${DROPLET_HOST} 'grep -v PASSWORD /etc/olander-proxy.env'"
  exit 2
fi

cat <<EOF >&2

[deploy] success.

  Droplet:        ${DROPLET_USER}@${DROPLET_HOST}
  Edge URL:       https://egress.${OLANDER_DOMAIN}/proxy
  Healthz:        $HEALTHZ_JSON

Next:
  ./scripts/verify-droplet.sh    # runs the four production-ready checks

EOF
