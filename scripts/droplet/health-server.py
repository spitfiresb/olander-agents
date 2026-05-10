#!/usr/bin/env python3
"""
HTTP service that exposes the droplet's P21-egress health.

Reads:
  /var/lib/olander-health/latest.json  — current check result
  /var/lib/olander-health/log.jsonl    — rolling history (1 line per check)

Endpoints:
  GET /health    — { latest: {...}, uptime: { "1h": {...}, "24h": {...}, "7d": {...} } }

Auth:
  Bearer token. Set OLANDER_HEALTH_TOKEN in the environment (systemd EnvironmentFile).
  Requests without a matching `Authorization: Bearer <token>` header get 401.

Why a Python stdlib server: zero dependencies, ships with Ubuntu 24.04, easy
to audit. Caller is the Next.js app (server-side fetch), not the browser, so
plain HTTP on a non-standard port is acceptable for the MVP. Upgrade to TLS
via Caddy if/when there's a domain.
"""

import hmac
import json
import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA_DIR = os.environ.get("DATA_DIR", "/var/lib/olander-health")
LATEST_FILE = os.path.join(DATA_DIR, "latest.json")
LOG_FILE = os.path.join(DATA_DIR, "log.jsonl")
TOKEN = os.environ.get("OLANDER_HEALTH_TOKEN", "")
PORT = int(os.environ.get("PORT", "8088"))
HOST = os.environ.get("HOST", "0.0.0.0")

WINDOWS = {"1h": timedelta(hours=1), "24h": timedelta(hours=24), "7d": timedelta(days=7)}

logging.basicConfig(level=logging.INFO, format="[health-server] %(message)s")
log = logging.getLogger("health-server")


def load_latest():
    try:
        with open(LATEST_FILE, "r") as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except json.JSONDecodeError as e:
        log.warning("latest.json is unparseable: %s", e)
        return None


def parse_iso(ts):
    if not isinstance(ts, str):
        raise ValueError("checked_at must be a string")
    if ts.endswith("Z"):
        ts = ts[:-1] + "+00:00"
    return datetime.fromisoformat(ts)


def compute_uptime(now):
    """Stream the log once, bucket each line into every applicable window."""
    buckets = {k: {"checks": 0, "ok": 0} for k in WINDOWS}
    cutoffs = {k: now - delta for k, delta in WINDOWS.items()}
    try:
        with open(LOG_FILE, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                    ts = parse_iso(rec["checked_at"])
                except (json.JSONDecodeError, KeyError, ValueError, TypeError, AttributeError):
                    continue
                ok = rec.get("overall") == "ok"
                for window, cutoff in cutoffs.items():
                    if ts >= cutoff:
                        buckets[window]["checks"] += 1
                        if ok:
                            buckets[window]["ok"] += 1
    except FileNotFoundError:
        pass

    out = {}
    for window, b in buckets.items():
        pct = (b["ok"] / b["checks"] * 100) if b["checks"] else None
        out[window] = {
            "checks": b["checks"],
            "ok": b["ok"],
            "pct": round(pct, 3) if pct is not None else None,
        }
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quiet default access log
        log.info("%s - %s", self.address_string(), fmt % args)

    def _unauthorized(self):
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Bearer realm="olander-health"')
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"error":"unauthorized"}')

    def _check_auth(self):
        if not TOKEN:
            log.error("OLANDER_HEALTH_TOKEN is not set — refusing all requests")
            return False
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return False
        # Constant-time comparison: prevents an attacker from learning the
        # token byte-by-byte via response-time differences.
        return hmac.compare_digest(header[7:].strip(), TOKEN)

    def do_GET(self):
        if self.path != "/health":
            self.send_response(404)
            self.end_headers()
            return
        if not self._check_auth():
            self._unauthorized()
            return

        latest = load_latest()
        uptime = compute_uptime(datetime.now(timezone.utc))
        body = json.dumps(
            {"latest": latest, "uptime": uptime},
            separators=(",", ":"),
        ).encode()

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    if not TOKEN:
        log.error("OLANDER_HEALTH_TOKEN is required")
        sys.exit(1)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    log.info("listening on %s:%d", HOST, PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
