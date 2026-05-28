#!/usr/bin/env bash
# Dump the P21 schema — every Data Services view (`/data/erp/views/v1/<view>`)
# with its full column list — into a markdown file you can commit to docs/.
#
# Run this ON THE DROPLET. P21 only accepts traffic from the whitelisted
# egress IP, so this won't work anywhere else.
#
# Usage (on droplet):
#     bash dump-p21-schema.sh > /tmp/P21_Schema.md
#     # then on your laptop:
#     scp root@<droplet>:/tmp/P21_Schema.md docs/P21_Schema.md
#
# What it writes:
#     stdout              → markdown (views + columns), redirect to a file
#     /tmp/p21-apiref.html → raw HTML of /docs/apiref.aspx (Entity REST list)
#     /tmp/p21-metadata.xml → raw OData $metadata (for re-parsing later)
#
# Reads P21_USERNAME / P21_PASSWORD from /etc/olander-proxy.env (the file the
# proxy service already uses). Override with OLANDER_PROXY_ENV=/path/to/env.

set -euo pipefail

ENV_FILE=${OLANDER_PROXY_ENV:-/etc/olander-proxy.env}
if [ ! -r "$ENV_FILE" ]; then
  echo "missing $ENV_FILE — set OLANDER_PROXY_ENV if it lives elsewhere" >&2
  exit 1
fi
set -a; . "$ENV_FILE"; set +a

P21_BASE_URL=${P21_BASE_URL:-https://<p21-host>}
P21_BASE_URL=${P21_BASE_URL%/}

if [ -z "${P21_USERNAME:-}" ] || [ -z "${P21_PASSWORD:-}" ]; then
  echo "P21_USERNAME / P21_PASSWORD missing from $ENV_FILE" >&2
  exit 1
fi

# URL-encode the password — Olander's `OregonTC` password contains `#` which
# breaks the query string raw. Python3 is on every droplet by default.
PW=$(python3 -c "import urllib.parse, os; print(urllib.parse.quote(os.environ['P21_PASSWORD'], safe=''))")

echo "→ minting P21 token …" >&2
TOKEN=$(curl -sSf --max-time 15 \
  -X POST --data '' \
  "${P21_BASE_URL}/api/security/token/?username=${P21_USERNAME}&password=${PW}")
if [ -z "$TOKEN" ]; then
  echo "token mint returned empty body" >&2
  exit 1
fi
echo "→ token ok (length ${#TOKEN})" >&2

echo "→ fetching /docs/apiref.aspx (Entity REST endpoint list) …" >&2
curl -sS --max-time 60 \
  -H "Authorization: Bearer $TOKEN" \
  "${P21_BASE_URL}/docs/apiref.aspx" \
  > /tmp/p21-apiref.html
echo "  saved to /tmp/p21-apiref.html" >&2

echo "→ fetching \$metadata (Data Services views + columns) …" >&2
curl -sSf --max-time 120 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/xml" \
  "${P21_BASE_URL}/data/erp/views/v1/\$metadata" \
  > /tmp/p21-metadata.xml
echo "  saved to /tmp/p21-metadata.xml" >&2

echo "→ parsing \$metadata → markdown (writing to stdout)" >&2

python3 - "$P21_BASE_URL" <<'PY'
import sys, os, datetime as dt
import xml.etree.ElementTree as ET

base = sys.argv[1]
xml_text = open("/tmp/p21-metadata.xml", "r", encoding="utf-8").read()

# P21's OData $metadata uses one of several EDM namespace versions; try them
# in order so we don't have to know which the install ships with.
EDM_NAMESPACES = [
    "http://schemas.microsoft.com/ado/2009/11/edm",
    "http://schemas.microsoft.com/ado/2008/09/edm",
    "http://schemas.microsoft.com/ado/2007/05/edm",
]

root = ET.fromstring(xml_text)

# Find every EntityType under any of the candidate namespaces.
entity_types = []
for ns in EDM_NAMESPACES:
    found = root.findall(f".//{{{ns}}}EntityType")
    if found:
        entity_types = found
        edm_ns = ns
        break
else:
    edm_ns = None

def props_of(et):
    if not edm_ns: return []
    return et.findall(f"{{{edm_ns}}}Property")

def keys_of(et):
    if not edm_ns: return set()
    keys = set()
    for k in et.findall(f"{{{edm_ns}}}Key"):
        for r in k.findall(f"{{{edm_ns}}}PropertyRef"):
            n = r.get("Name")
            if n: keys.add(n)
    return keys

print(f"# P21 schema snapshot")
print()
print(f"_Generated {dt.date.today().isoformat()} by `scripts/droplet/dump-p21-schema.sh` "
      f"against `{base}`. Re-run any time the source schema changes._")
print()
print(f"## Data Services views (`/data/erp/views/v1/<view>`)")
print()
print(f"**Total: {len(entity_types)} views.**")
print()
print("These are the views the chatbot's `viewsQuery` tool can call. Each view has the columns listed below. "
      "Use this list to audit the scope rules in `src/lib/scopes.ts` — every view should land in exactly one "
      "named bucket (`inventory`, `customers`, `sales`, `vendors`, `purchasing`, `financials`, `hr_payroll`); "
      "anything uncategorized is denied for non-admins.")
print()

# Compact index up front so the file is greppable.
print("### Index")
print()
names = sorted([(et.get("Name") or "?") for et in entity_types])
for n in names:
    print(f"- [`{n}`](#{n.lower()})")
print()

print("### Per-view columns")
print()

for et in sorted(entity_types, key=lambda e: e.get("Name") or ""):
    name = et.get("Name") or "?"
    props = props_of(et)
    keys = keys_of(et)
    anchor = name.lower()
    print(f"#### `{name}`  <a id=\"{anchor}\"></a>")
    print()
    print(f"{len(props)} columns. Keys: {', '.join(sorted(keys)) if keys else '(none declared)'}.")
    print()
    print("| Column | Type | Nullable | Key |")
    print("|---|---|---|---|")
    for p in props:
        col = p.get("Name") or "?"
        typ = (p.get("Type") or "").replace("Edm.", "")
        nullable = p.get("Nullable", "true")
        is_key = "✓" if col in keys else ""
        print(f"| `{col}` | {typ} | {nullable} | {is_key} |")
    print()

print()
print("## Entity REST endpoints (`/api/<area>/<resource>/...`)")
print()
print("Raw HTML dump from P21's own `/docs/apiref.aspx` is at **`/tmp/p21-apiref.html`** on the droplet.")
print("Pull the area/resource list with:")
print()
print("```bash")
print("grep -oE 'api/[a-zA-Z0-9_/.-]+' /tmp/p21-apiref.html | sort -u")
print("```")
print()
print("That's what to audit `src/lib/scopes.ts` `ENTITY_RULES` against (the per-resource scope mapping for `entityGet`).")
PY

echo "→ done. Redirect stdout to a file to capture, e.g.:" >&2
echo "    bash $(basename "$0") > /tmp/P21_Schema.md" >&2
