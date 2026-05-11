#!/usr/bin/env python3
"""
HTTP service that exposes the droplet's P21-egress health.

Reads:
  /var/lib/olander-health/latest.json  — current check result
  /var/lib/olander-health/log.jsonl    — rolling history (1 line per check)

Endpoints:
  GET /health    — { latest, uptime: { "1h", "24h", "7d" }, daily: [{date,pct,...}] }

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
DAILY_DAYS = 90  # how many trailing UTC days the /health response includes

# In-memory cache for the bucketed log. Healthcheck appends to log.jsonl at
# most once per 60s, so a 30s cache costs at most one stale window — well
# inside the noise floor of "what does the dashboard show right now" — while
# capping per-request CPU at "read one dict from a tuple" instead of "parse
# 30 MB of JSONL." Cheap-droplet hygiene.
_CACHE_TTL_SECONDS = 30
_cache = None  # {"at": float, "uptime": ..., "daily": ...} or None

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


def _empty_buckets(windows):
    return {k: {"checks": 0, "ok": 0} for k in windows}


def _empty_daily(today):
    out = {}
    for i in range(DAILY_DAYS - 1, -1, -1):
        d = today - timedelta(days=i)
        out[d.isoformat()] = {"checks": 0, "ok": 0}
    return out


def _bucket_record(record_ok, ts, cutoffs, buckets, daily, daily_cutoff):
    for window, cutoff in cutoffs.items():
        if ts >= cutoff:
            buckets[window]["checks"] += 1
            if record_ok:
                buckets[window]["ok"] += 1
    day = ts.date()
    if day >= daily_cutoff:
        key = day.isoformat()
        if key in daily:
            daily[key]["checks"] += 1
            if record_ok:
                daily[key]["ok"] += 1


def _format(buckets, daily):
    uptime = {}
    for window, b in buckets.items():
        pct = (b["ok"] / b["checks"] * 100) if b["checks"] else None
        uptime[window] = {
            "checks": b["checks"],
            "ok": b["ok"],
            "pct": round(pct, 3) if pct is not None else None,
        }
    daily_out = []
    for date in sorted(daily.keys()):
        b = daily[date]
        pct = (b["ok"] / b["checks"] * 100) if b["checks"] else None
        daily_out.append({
            "date": date,
            "checks": b["checks"],
            "ok": b["ok"],
            "pct": round(pct, 3) if pct is not None else None,
        })
    return uptime, daily_out


def compute_uptime_and_daily(now):
    """Stream the log once, bucket records for P21, Anthropic, and P21 API.

    Records written before a given probe was added don't have its field — those
    are skipped from that probe's stats so we never count "no data" as either
    uptime or downtime. The p21_api bucket additionally gates on creds_present
    so the pre-creds bootstrap window doesn't contribute either.
    """
    cutoffs = {k: now - delta for k, delta in WINDOWS.items()}
    today = now.date()
    daily_cutoff = today - timedelta(days=DAILY_DAYS - 1)

    p21_buckets = _empty_buckets(WINDOWS)
    p21_daily = _empty_daily(today)
    anth_buckets = _empty_buckets(WINDOWS)
    anth_daily = _empty_daily(today)
    api_buckets = _empty_buckets(WINDOWS)
    api_daily = _empty_daily(today)

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
                # P21 health: existing semantics — overall == "ok" passes.
                _bucket_record(
                    rec.get("overall") == "ok",
                    ts, cutoffs, p21_buckets, p21_daily, daily_cutoff,
                )
                # Anthropic: only count records that observed it.
                anth = (rec.get("checks") or {}).get("anthropic")
                if isinstance(anth, dict):
                    _bucket_record(
                        anth.get("ok") is True,
                        ts, cutoffs, anth_buckets, anth_daily, daily_cutoff,
                    )
                # P21 API: only count records where the probe actually ran
                # (creds present + field emitted).
                api = (rec.get("checks") or {}).get("p21_api")
                if isinstance(api, dict) and api.get("creds_present"):
                    _bucket_record(
                        api.get("ok") is True,
                        ts, cutoffs, api_buckets, api_daily, daily_cutoff,
                    )
    except FileNotFoundError:
        pass

    p21_uptime, p21_daily_out = _format(p21_buckets, p21_daily)
    anth_uptime, anth_daily_out = _format(anth_buckets, anth_daily)
    api_uptime, api_daily_out = _format(api_buckets, api_daily)
    return p21_uptime, p21_daily_out, anth_uptime, anth_daily_out, api_uptime, api_daily_out


def get_cached_uptime_and_daily(now):
    global _cache
    now_ts = now.timestamp()
    if _cache is not None and (now_ts - _cache["at"]) < _CACHE_TTL_SECONDS:
        return _cache["data"]
    data = compute_uptime_and_daily(now)
    _cache = {"at": now_ts, "data": data}
    return data


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
        (
            p21_uptime, p21_daily,
            anth_uptime, anth_daily,
            api_uptime, api_daily,
        ) = get_cached_uptime_and_daily(datetime.now(timezone.utc))
        body = json.dumps(
            {
                "latest": latest,
                "uptime": p21_uptime,
                "daily": p21_daily,
                "anthropic": {"uptime": anth_uptime, "daily": anth_daily},
                "p21_api": {"uptime": api_uptime, "daily": api_daily},
            },
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
