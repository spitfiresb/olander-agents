#!/usr/bin/env bash
# Production-readiness checks for the Layer-2 droplet proxy.
# Reads DROPLET_PROXY_URL + DROPLET_PROXY_TOKEN from .env.local and exercises
# the four behaviors that need to be green before Layer 2 is "done":
#
#   1. POST /proxy/views/p21_view_inv_mast        → one normalized row
#   2. GET  /proxy/entity/inventory/v2/parts/<id> → part record
#   3. /proxy/healthz                              → creds_present:true
#   4. /proxy/healthz with bad bearer              → 401
#
# Exits 0 if all four pass; non-zero on first failure. Safe to re-run.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env.local"

[[ -f "$ENV_FILE" ]] || { echo "[verify] .env.local missing at $ENV_FILE" >&2; exit 1; }

read_dotenv() {
  python3 - "$ENV_FILE" "$1" <<'PY'
import sys
path, key = sys.argv[1], sys.argv[2]
with open(path) as f:
    for raw in f:
        line = raw.lstrip()
        if not line or line.startswith("#") or "=" not in line: continue
        k, v = line.split("=", 1)
        if k.strip() != key: continue
        v = v.rstrip("\n").rstrip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
            v = v[1:-1]
        print(v)
        break
PY
}

PROXY_URL="$(read_dotenv DROPLET_PROXY_URL)"
PROXY_TOKEN="$(read_dotenv DROPLET_PROXY_TOKEN)"

if [[ -z "$PROXY_URL" || -z "$PROXY_TOKEN" ]]; then
  echo "[verify] DROPLET_PROXY_URL or DROPLET_PROXY_TOKEN missing from .env.local" >&2
  exit 1
fi

PROXY_URL="${PROXY_URL%/}"     # trim trailing slash if any
echo "[verify] target: $PROXY_URL"

pass=0; fail=0
print_pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
print_fail() { printf '  \033[31m✗\033[0m %s\n  %s\n' "$1" "$2"; fail=$((fail+1)); }

# --- 1. viewsQuery ---------------------------------------------------------
echo "[1/4] POST /proxy/views/p21_view_inv_mast {top:1}"
RESP="$(curl -sS --max-time 25 \
  -H "Authorization: Bearer $PROXY_TOKEN" \
  -H 'Content-Type: application/json' \
  -X POST -d '{"top":1,"select":["item_id","item_desc","inv_mast_uid"]}' \
  "$PROXY_URL/proxy/views/p21_view_inv_mast" 2>/dev/null || true)"
if grep -q '"rows":\[{' <<<"$RESP" && grep -q '"item_id"' <<<"$RESP"; then
  print_pass "viewsQuery returned a normalized row"
  echo "      $(head -c 200 <<<"$RESP")..."
else
  print_fail "viewsQuery did not return rows" "$(head -c 300 <<<"$RESP")"
fi

# --- 2. entityGet (use the item_id we just discovered, if any) -------------
ITEM_ID="$(python3 -c '
import json, sys
try:
  d = json.loads(sys.argv[1])
  print(d["rows"][0].get("item_id",""))
except Exception:
  pass' "$RESP" 2>/dev/null || true)"
ITEM_ID="${ITEM_ID:-PN12345-01}"
echo "[2/4] GET /proxy/entity/inventory/v2/parts/$ITEM_ID"
RESP2="$(curl -sS --max-time 25 \
  -H "Authorization: Bearer $PROXY_TOKEN" \
  "$PROXY_URL/proxy/entity/inventory/v2/parts/$ITEM_ID" 2>/dev/null || true)"
if grep -qE '"item_id"|"object_name"' <<<"$RESP2"; then
  print_pass "entityGet returned a record for $ITEM_ID"
  echo "      $(head -c 200 <<<"$RESP2")..."
else
  print_fail "entityGet for $ITEM_ID did not return a record" "$(head -c 300 <<<"$RESP2")"
fi

# --- 3. healthz with creds_present ----------------------------------------
echo "[3/4] GET /proxy/healthz (creds_present should be true)"
RESP3="$(curl -sS --max-time 10 \
  -H "Authorization: Bearer $PROXY_TOKEN" \
  "$PROXY_URL/proxy/healthz" 2>/dev/null || true)"
if grep -q '"creds_present":true' <<<"$RESP3"; then
  print_pass "healthz reports creds_present:true"
  echo "      $RESP3"
else
  print_fail "healthz did not report creds_present:true" "$RESP3"
fi

# --- 4. healthz with bad bearer should 401 --------------------------------
echo "[4/4] GET /proxy/healthz with wrong bearer (expect 401)"
STATUS4="$(curl -sS -o /dev/null --max-time 10 -w '%{http_code}' \
  -H 'Authorization: Bearer not-the-real-token' \
  "$PROXY_URL/proxy/healthz" 2>/dev/null || true)"
if [[ "$STATUS4" == "401" ]]; then
  print_pass "bad bearer correctly returns 401"
else
  print_fail "bad bearer returned $STATUS4 (expected 401)" ""
fi

echo
if (( fail == 0 )); then
  echo "[verify] all $pass checks passed — Layer 2 is production-ready."
else
  echo "[verify] $pass passed, $fail failed — see output above."
  exit 1
fi
