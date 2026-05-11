#!/usr/bin/env node
// Olander P21 proxy (Layer 2). Vercel /api/chat tools call us at:
//   POST https://egress.<domain>/proxy/views/<viewName>
//   GET  https://egress.<domain>/proxy/entity/<area>/<resource>/<id>
//   GET  https://egress.<domain>/proxy/healthz
//
// We validate the inbound bearer (OLANDER_PROXY_TOKEN), mint+cache a P21
// bearer with the credentials in /etc/olander-proxy.env, translate to the
// upstream REST call, normalize the response, and return JSON.
//
// Inherits the droplet's SNAT egress + /etc/hosts override, so the upstream
// call is a vanilla fetch("https://<p21-host>/...").
//
// Bound to 127.0.0.1; reachable externally only via Caddy. Caddy forwards
// Authorization untouched — we re-check here so loopback probes still pass.
//
// Zero-dep: Node 22 stdlib (http, crypto, native fetch).

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const TOKEN = (process.env.OLANDER_PROXY_TOKEN ?? "").trim();
const PORT = parseInt(process.env.PORT ?? "8089", 10);
const HOST = process.env.HOST ?? "127.0.0.1";

const P21_BASE_URL = (process.env.P21_BASE_URL ?? "https://<p21-host>").trim().replace(/\/+$/, "");
const P21_USERNAME = (process.env.P21_USERNAME ?? "").trim();
const P21_PASSWORD = process.env.P21_PASSWORD ?? "";
// Future: P21_CONSUMER_KEY swaps in for username/password. Detected at runtime.
const P21_CONSUMER_KEY = (process.env.P21_CONSUMER_KEY ?? "").trim();

const CREDS_PRESENT = Boolean((P21_USERNAME && P21_PASSWORD) || P21_CONSUMER_KEY);

if (!TOKEN) {
  console.error("[proxy] OLANDER_PROXY_TOKEN is required");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Logging — JSON line per event, stdout (journald captures it). Secrets are
// never reflected; URL query-strings holding `password=` are scrubbed.
// ---------------------------------------------------------------------------

const SCRUB_KEYS = /(password|consumer_key|token|authorization)/i;

function scrubUrl(u) {
  try {
    const parsed = new URL(u);
    for (const [k] of parsed.searchParams) {
      if (SCRUB_KEYS.test(k)) parsed.searchParams.set(k, "<redacted>");
    }
    return parsed.toString();
  } catch {
    return u;
  }
}

function log(event, extra = {}) {
  const line = { t: new Date().toISOString(), event, ...extra };
  if (line.url) line.url = scrubUrl(line.url);
  // Headers/body never logged: callers always pass tokens via Authorization.
  process.stdout.write(JSON.stringify(line) + "\n");
}

// ---------------------------------------------------------------------------
// Inbound auth
// ---------------------------------------------------------------------------

function checkAuth(req) {
  const header = req.headers["authorization"] ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice(7).trim(), "utf8");
  const expected = Buffer.from(TOKEN, "utf8");
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

function send(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(payload);
}

function unauthorized(res) {
  send(
    res,
    401,
    { error: "unauthorized" },
    { "WWW-Authenticate": 'Bearer realm="olander-proxy"' },
  );
}

async function readJson(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// ---------------------------------------------------------------------------
// P21 token cache. Mint on first need; proactively refresh at 90% of TTL.
// Single in-flight refresh — concurrent callers share the same promise.
// ---------------------------------------------------------------------------

const TOKEN_FETCH_TIMEOUT_MS = 15_000;
const UPSTREAM_TIMEOUT_MS = 25_000; // P21 itself times out at 30s; finish first.
const REFRESH_AT_RATIO = 0.9;

let cachedToken = null;        // { token, mintedAt: ms, expiresAt: ms }
let inflightMint = null;       // Promise<{token,...}>

function nowMs() {
  return Date.now();
}

function tokenStale(t) {
  if (!t) return true;
  const ttlMs = t.expiresAt - t.mintedAt;
  return nowMs() >= t.mintedAt + ttlMs * REFRESH_AT_RATIO;
}

function urlEncode(s) {
  return encodeURIComponent(s);
}

async function mintP21Token() {
  if (!CREDS_PRESENT) {
    const err = new Error("credentials_pending");
    err.code = "credentials_pending";
    throw err;
  }

  const username = P21_CONSUMER_KEY ? P21_CONSUMER_KEY : P21_USERNAME;
  const password = P21_CONSUMER_KEY ? "" : P21_PASSWORD;
  const url = `${P21_BASE_URL}/api/security/token/?username=${urlEncode(username)}&password=${urlEncode(password)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TOKEN_FETCH_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Length": "0" }, // IIS returns 411 without this.
      body: "",
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    log("mint_failed", { status: resp.status, body_preview: body.slice(0, 200) });
    const err = new Error(`mint_failed_${resp.status}`);
    err.code = "mint_failed";
    err.status = resp.status;
    throw err;
  }

  const raw = (await resp.text()).trim();
  if (!raw) {
    const err = new Error("mint_empty_body");
    err.code = "mint_failed";
    throw err;
  }

  // JWT — decode `exp` (seconds) to pick an absolute expiry. If parsing fails,
  // assume the documented 24h TTL.
  let expiresAt = nowMs() + 24 * 3600 * 1000;
  try {
    const payload = raw.split(".")[1];
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof json.exp === "number") expiresAt = json.exp * 1000;
  } catch {
    /* fall through to default */
  }

  const t = { token: raw, mintedAt: nowMs(), expiresAt };
  log("mint_ok", { ttl_s: Math.round((expiresAt - nowMs()) / 1000) });
  return t;
}

async function getP21Token({ forceRefresh = false } = {}) {
  if (!forceRefresh && cachedToken && !tokenStale(cachedToken)) {
    return cachedToken;
  }
  if (inflightMint) return inflightMint;
  inflightMint = mintP21Token()
    .then((t) => {
      cachedToken = t;
      return t;
    })
    .finally(() => {
      inflightMint = null;
    });
  return inflightMint;
}

// ---------------------------------------------------------------------------
// Response normalization
//
// Data Services tier: snake_case keys, numbers as strings, "Y"/"N" booleans.
// Entity REST tier:   PascalCase keys, numbers as numbers, "Y"/"N" booleans.
//
// We normalize both to: snake_case keys, JSON booleans from Y/N (where we can
// be sure), numeric strings → numbers for fields that look numeric. Dates and
// nulls pass through. Output is what tool code consumes — single shape.
// ---------------------------------------------------------------------------

function pascalToSnake(key) {
  // PascalCase / camelCase → snake_case. Handles runs of caps as a unit:
  // "InvMastUid" → "inv_mast_uid", "ItemId" → "item_id", "MSDS" → "msds".
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

const YN_FIELD_HINTS = /(_flag$|^delete_flag$|^track_lots$|^inactive$|^taxable$|^is_)/;
const NUMERIC_FIELD_HINTS = /(_uid$|_id$|^uid$|price|cost|qty|quantity|weight|amount|total|length|width|height|count|num_|_no$|_number$)/i;

function normalizeValue(key, v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map((x) => (typeof x === "object" ? normalizeRow(x) : x));
  if (typeof v === "object") return normalizeRow(v);
  if (typeof v === "string") {
    // Y/N → bool, but only for fields whose names look like flags. We can't
    // safely treat every "Y" as true (e.g. a single-char SKU prefix).
    if ((v === "Y" || v === "N") && YN_FIELD_HINTS.test(key)) {
      return v === "Y";
    }
    // Numeric strings → numbers, but only for fields whose names look numeric.
    // Avoids parsing "PN12345-01" as NaN-resulting numbers or, worse, "12-34".
    if (NUMERIC_FIELD_HINTS.test(key) && /^-?\d+(\.\d+)?$/.test(v)) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return v;
}

function normalizeRow(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    // Strip OData annotations like "odata.metadata" or "@odata.context".
    if (k.startsWith("odata.") || k.startsWith("@odata.")) continue;
    const sk = pascalToSnake(k);
    out[sk] = normalizeValue(sk, v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Upstream call wrapper. Handles TokenError → one-shot refresh + retry, maps
// upstream XML errors to clean JSON, applies a hard timeout.
// ---------------------------------------------------------------------------

async function p21Fetch(path, { method = "GET", searchParams = null } = {}) {
  const url = new URL(path, P21_BASE_URL + "/");
  if (searchParams) {
    for (const [k, v] of Object.entries(searchParams)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }

  const doFetch = async (token) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const resp = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: ctrl.signal,
      });
      const text = await resp.text();
      return { resp, text };
    } finally {
      clearTimeout(timer);
    }
  };

  let { token } = await getP21Token();
  let { resp, text } = await doFetch(token);

  // 401 with TokenError XML → mint a fresh token once and retry.
  if (resp.status === 401 && /<TokenError\b/i.test(text)) {
    log("token_invalid_retry", { url: url.toString() });
    ({ token } = await getP21Token({ forceRefresh: true }));
    ({ resp, text } = await doFetch(token));
  }

  if (!resp.ok) {
    // Surface as structured JSON regardless of upstream content-type.
    log("upstream_error", { url: url.toString(), status: resp.status, body_preview: text.slice(0, 200) });
    const err = new Error(`upstream_${resp.status}`);
    err.code = "upstream_error";
    err.status = resp.status;
    err.detail = text.slice(0, 500);
    throw err;
  }

  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    log("upstream_non_json", { url: url.toString(), body_preview: text.slice(0, 200) });
    const err = new Error("upstream_non_json");
    err.code = "upstream_non_json";
    throw err;
  }
}

// ---------------------------------------------------------------------------
// View name guard. Per P21_API.md §Tier 1, view names must be `p21_view_*`
// and we restrict to that prefix to keep the surface narrow and reject path
// traversal via funky names.
// ---------------------------------------------------------------------------

const VIEW_NAME_RE = /^p21_view_[a-z0-9_]+$/i;
const AREA_RE = /^[a-z][a-z0-9_]*$/i;
const RESOURCE_SEGMENT_RE = /^[a-zA-Z0-9._-]+$/; // allows "v2/parts" via split

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleViewsQuery(viewName, body) {
  if (!VIEW_NAME_RE.test(viewName)) {
    return { status: 400, body: { error: "bad_view_name", detail: "view name must match p21_view_*" } };
  }

  const { filter, top, skip, select, orderBy } = body ?? {};
  const params = {};
  if (typeof filter === "string" && filter) params["$filter"] = filter;
  if (typeof top === "number" && Number.isFinite(top)) params["$top"] = Math.min(Math.max(1, top), 200);
  if (typeof skip === "number" && Number.isFinite(skip) && skip >= 0) params["$skip"] = skip;
  if (typeof select === "string" && select) params["$select"] = select;
  if (Array.isArray(select) && select.length) params["$select"] = select.join(",");
  if (typeof orderBy === "string" && orderBy) params["$orderby"] = orderBy;

  try {
    const data = await p21Fetch(`/data/erp/views/v1/${viewName}`, { searchParams: params });
    const rows = Array.isArray(data?.value) ? data.value.map(normalizeRow) : [];
    return { status: 200, body: { rows, count: rows.length } };
  } catch (e) {
    return mapError(e);
  }
}

async function handleEntityGet(area, resource, id, extendedProperties) {
  if (!AREA_RE.test(area)) {
    return { status: 400, body: { error: "bad_area" } };
  }
  // Allow "v2/parts" style — split on '/' and validate each.
  const segs = resource.split("/");
  if (!segs.every((s) => RESOURCE_SEGMENT_RE.test(s))) {
    return { status: 400, body: { error: "bad_resource" } };
  }
  if (!RESOURCE_SEGMENT_RE.test(id)) {
    return { status: 400, body: { error: "bad_id" } };
  }

  const params = {};
  if (typeof extendedProperties === "string" && extendedProperties) {
    params.extendedProperties = extendedProperties;
  }

  try {
    const data = await p21Fetch(`/api/${area}/${resource}/${encodeURIComponent(id)}`, { searchParams: params });
    return { status: 200, body: normalizeRow(data) };
  } catch (e) {
    return mapError(e);
  }
}

function mapError(e) {
  if (e.code === "credentials_pending") {
    return {
      status: 503,
      body: { error: "credentials_pending", detail: "P21 credentials not configured on droplet" },
    };
  }
  if (e.code === "mint_failed") {
    return {
      status: 502,
      body: { error: "mint_failed", status: e.status ?? 0 },
    };
  }
  if (e.code === "upstream_error") {
    return {
      status: e.status === 401 ? 502 : 502,
      body: { error: "upstream_error", status: e.status, detail: scrubDetail(e.detail) },
    };
  }
  if (e.code === "upstream_non_json") {
    return { status: 502, body: { error: "upstream_non_json" } };
  }
  if (e.name === "AbortError") {
    return { status: 504, body: { error: "upstream_timeout" } };
  }
  return { status: 500, body: { error: "internal_error" } };
}

function scrubDetail(s) {
  if (!s) return undefined;
  // Don't echo XML token errors back to callers verbatim.
  if (/<TokenError/i.test(s)) return "TokenError";
  return s.slice(0, 200);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const started = nowMs();
  const url = new URL(req.url ?? "/", `http://${HOST}`);

  try {
    // /proxy/healthz is the only unauthenticated route — the healthcheck.sh
    // probe still passes a bearer because we always require it.
    if (!checkAuth(req)) {
      unauthorized(res);
      log("req", { method: req.method, path: url.pathname, status: 401, ms: nowMs() - started });
      return;
    }

    if (req.method === "GET" && url.pathname === "/proxy/healthz") {
      const tokenAge =
        cachedToken != null ? Math.round((nowMs() - cachedToken.mintedAt) / 1000) : null;
      send(res, 200, {
        ok: true,
        creds_present: CREDS_PRESENT,
        token_age_seconds: tokenAge,
        p21_reachable: cachedToken != null,
      });
      log("req", { method: "GET", path: url.pathname, status: 200, ms: nowMs() - started });
      return;
    }

    // POST /proxy/views/:viewName
    const viewsMatch = url.pathname.match(/^\/proxy\/views\/([^/]+)$/);
    if (viewsMatch && req.method === "POST") {
      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        send(res, 400, { error: "bad_request", detail: String(e.message ?? e) });
        log("req", { method: "POST", path: url.pathname, status: 400, ms: nowMs() - started });
        return;
      }
      const result = await handleViewsQuery(viewsMatch[1], body);
      send(res, result.status, result.body);
      log("req", {
        method: "POST",
        path: url.pathname,
        status: result.status,
        ms: nowMs() - started,
        view: viewsMatch[1],
      });
      return;
    }

    // GET /proxy/entity/:area/:resource(...)/:id
    // We accept :resource segments containing '/' (e.g. "v2/parts"), so split
    // on the entity prefix and pull id off the tail.
    const entityMatch = url.pathname.match(/^\/proxy\/entity\/([^/]+)\/(.+)\/([^/]+)$/);
    if (entityMatch && req.method === "GET") {
      const [, area, resource, id] = entityMatch;
      const extendedProperties = url.searchParams.get("extendedProperties") ?? undefined;
      const result = await handleEntityGet(area, resource, id, extendedProperties);
      send(res, result.status, result.body);
      log("req", {
        method: "GET",
        path: url.pathname,
        status: result.status,
        ms: nowMs() - started,
        area,
        resource,
      });
      return;
    }

    send(res, 404, { error: "not_found" });
    log("req", { method: req.method, path: url.pathname, status: 404, ms: nowMs() - started });
  } catch (e) {
    log("handler_crash", { err: String(e?.message ?? e), stack: e?.stack?.split("\n").slice(0, 3).join(" | ") });
    if (!res.headersSent) send(res, 500, { error: "internal_error" });
  }
});

server.listen(PORT, HOST, () => {
  log("listen", { host: HOST, port: PORT, creds_present: CREDS_PRESENT, p21_base: P21_BASE_URL });
});

const shutdown = (sig) => {
  log("shutdown", { signal: sig });
  server.close(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
