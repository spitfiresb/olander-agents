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

import { createServer, Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { timingSafeEqual } from "node:crypto";

// Keep-alive agents shave the TLS handshake (~80–200ms) off every upstream
// P21 call. Node's global agent defaults are conservative for proxy use.
const httpAgent = new HttpAgent({ keepAlive: true, keepAliveMsecs: 30_000 });
const httpsAgent = new HttpsAgent({ keepAlive: true, keepAliveMsecs: 30_000 });
function dispatchAgent(parsedUrl) {
  return parsedUrl.protocol === "https:" ? httpsAgent : httpAgent;
}

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
// Per-IP rate limiter. 30 requests / minute per remote IP, bursts up to 30.
// Healthz is exempt — kept simple by checking the path before the bucket.
// ---------------------------------------------------------------------------

const RATE_CAPACITY = 30;
const RATE_REFILL_PER_SEC = 30 / 60;
const ipBuckets = new Map();
let lastIpSweep = Date.now();

function clientIpFor(req) {
  const xff = (req.headers["x-forwarded-for"] ?? "").toString();
  const first = xff.split(",")[0]?.trim();
  if (first) return first;
  return req.socket?.remoteAddress ?? "unknown";
}

function rateCheck(ip) {
  const now = Date.now();
  if (now - lastIpSweep > 5 * 60_000) {
    lastIpSweep = now;
    for (const [k, b] of ipBuckets) {
      if (now - b.t > 30 * 60_000) ipBuckets.delete(k);
    }
  }
  const existing = ipBuckets.get(ip);
  const elapsedSec = existing ? (now - existing.t) / 1000 : 0;
  const tokens = existing
    ? Math.min(RATE_CAPACITY, existing.n + elapsedSec * RATE_REFILL_PER_SEC)
    : RATE_CAPACITY;
  if (tokens >= 1) {
    ipBuckets.set(ip, { n: tokens - 1, t: now });
    return { ok: true };
  }
  ipBuckets.set(ip, { n: tokens, t: now });
  const retryAfterSec = Math.ceil((1 - tokens) / RATE_REFILL_PER_SEC);
  return { ok: false, retryAfterSec };
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

// Active P21 API probe. Token mint + 1-row view query against p21_view_inv_mast.
// Lazy: only runs when /healthz is called and the cached result is stale. The
// bash healthcheck timer drives /healthz once per 60s, so the cadence aligns
// naturally with PROBE_TTL_MS and we never burn P21 quota when nothing reads.
const PROBE_TTL_MS = 60_000;
const PROBE_VIEW = "p21_view_inv_mast";
// _uid columns are primary keys; safer than item_id if Olander remaps SKUs.
const PROBE_SELECT = "inv_mast_uid";
const PROBE_DISABLED = process.env.OLANDER_PROBE_DISABLED === "1";

let probeCache = null;         // { at, token_ok, view_query_ok, last_error, latency_ms }
let inflightProbe = null;      // Promise<probe-result>

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
// P21 API probe — exercises the full auth + read path the chatbot depends on.
// Reuses getP21Token (which respects the 24h token cache) and p21Fetch (which
// already retries once on TokenError XML). Result is cached for PROBE_TTL_MS
// so consecutive /healthz hits are cheap.
// ---------------------------------------------------------------------------

function probeErrorString(e) {
  // e.code covers our tagged errors (credentials_pending, mint_failed,
  // upstream_error, upstream_non_json). Fall back to message for surprises.
  const raw = e?.code || e?.message || String(e);
  return String(raw).slice(0, 80);
}

async function runP21Probe() {
  const start = nowMs();
  if (PROBE_DISABLED) {
    // Escape hatch: if probe goes haywire in production, flip
    // OLANDER_PROBE_DISABLED=1 + restart to silence the row without reverting.
    return { token_ok: true, view_query_ok: true, last_error: "probe_disabled", latency_ms: 0 };
  }
  if (!CREDS_PRESENT) {
    return { token_ok: false, view_query_ok: false, last_error: "credentials_pending", latency_ms: 0 };
  }

  let token_ok = false;
  try {
    await getP21Token({ forceRefresh: false });
    token_ok = true;
  } catch (e) {
    return {
      token_ok: false,
      view_query_ok: false,
      last_error: probeErrorString(e),
      latency_ms: nowMs() - start,
    };
  }

  try {
    await p21Fetch(`/data/erp/views/v1/${PROBE_VIEW}`, {
      searchParams: { "$top": 1, "$select": PROBE_SELECT },
    });
    return { token_ok, view_query_ok: true, last_error: null, latency_ms: nowMs() - start };
  } catch (e) {
    return {
      token_ok,
      view_query_ok: false,
      last_error: probeErrorString(e),
      latency_ms: nowMs() - start,
    };
  }
}

async function getProbeCached() {
  const now = nowMs();
  if (probeCache && now - probeCache.at < PROBE_TTL_MS) {
    return probeCache;
  }
  if (inflightProbe) return inflightProbe;
  inflightProbe = runP21Probe()
    .then((result) => {
      probeCache = { at: nowMs(), ...result };
      return probeCache;
    })
    .finally(() => {
      inflightProbe = null;
    });
  return inflightProbe;
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
    // Cap serialized response at 100KB. Wide views can blow past LLM context
    // budgets without warning; we'd rather truncate cleanly than send 1MB.
    const responseBody = { rows, count: rows.length };
    const serialized = JSON.stringify(responseBody);
    if (serialized.length > 100_000) {
      // Trim rows until we fit. Worst case is one massive row, in which case
      // we surface a clear truncation marker rather than partial JSON.
      let trimmed = rows.slice();
      while (trimmed.length > 0 && JSON.stringify({ rows: trimmed, count: trimmed.length }).length > 100_000) {
        trimmed = trimmed.slice(0, Math.max(1, Math.floor(trimmed.length * 0.5)));
      }
      return {
        status: 200,
        body: {
          rows: trimmed,
          count: trimmed.length,
          payload_truncated: true,
          original_row_count: rows.length,
        },
      };
    }
    return { status: 200, body: responseBody };
  } catch (e) {
    return mapError(e);
  }
}

// ---------------------------------------------------------------------------
// Aggregation — server-side SUM / COUNT / AVG / MIN / MAX (+ optional GROUP BY).
//
// P21's OData v3 tier has no $apply, but it DOES support the two operators that
// matter here, both verified live:
//   - $inlinecount=allpages → the EXACT total row count in one request (COUNT).
//   - $orderby + $top=1      → the EXACT extreme in one request (MIN / MAX).
// For SUM / AVG / grouped rankings there's no server-side fold, so we page the
// view HERE on the droplet — one hop from P21, big pages ($top=2000), gentle
// bounded concurrency — and fold the rows. Measured ~2000 rows / 150ms per
// connection, so the whole population is reachable in seconds, where the
// Vercel-side per-page loop (≈600 internet round-trips) had to cap at ~2000
// rows. $inlinecount gives the exact population up front, so we return
// `total_count` + `complete` and the caller states exact coverage instead of a
// vague "partial". Bounded by a row/time budget to stay gentle on the shared
// ERP and within the 512MB box.
//
// Scope + cost/margin redaction are enforced in the APP layer (tools.ts) before
// this is ever called — same trust boundary as /proxy/views.
// ---------------------------------------------------------------------------

const AGG_PAGE = 2000; // P21 honors large pages; one projected column keeps each tiny
const AGG_CONCURRENCY = 6; // gentle on the shared dev ERP — 6 in flight, not hundreds
const AGG_TIME_BUDGET_MS = 18_000; // < the app's 25s proxy timeout, leaves margin
const AGG_MAX_ROWS = 300_000; // hard ceiling on a 512MB box (~150 pages)
const AGG_COL_RE = /^[a-z0-9_]+$/i;
const AGG_ORDER_RE = /^[a-z0-9_]+(\s+(asc|desc))?$/i;

function aggNum(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function aggReduce(op, acc) {
  switch (op) {
    case "count": return acc.count;
    case "sum": return acc.sum;
    case "avg": return acc.n ? acc.sum / acc.n : null;
    case "min": return acc.n ? acc.min : null;
    case "max": return acc.n ? acc.max : null;
    default: return null;
  }
}

// Post-fold predicate on a group's aggregate value. Lets the caller ask for
// "groups where the total is 0" (dead stock: max on-hand = 0), "below safety
// stock", "never sold", etc. — the bottom/zero questions a plain top-N ranking
// can't express. eq on a fold of floats is exact only for integer columns; for
// summed decimals prefer le/ge thresholds (documented in the tool).
const HAVING_OPS = new Set(["eq", "ne", "gt", "ge", "lt", "le"]);
function havingPass(h, v) {
  if (!h) return true;
  switch (h.op) {
    case "eq": return v === h.value;
    case "ne": return v !== h.value;
    case "gt": return v > h.value;
    case "ge": return v >= h.value;
    case "lt": return v < h.value;
    case "le": return v <= h.value;
    default: return true;
  }
}

async function handleAggregate(viewName, body) {
  if (!VIEW_NAME_RE.test(viewName)) {
    return { status: 400, body: { error: "bad_view_name", detail: "view name must match p21_view_*" } };
  }
  const { op, column, filter, groupBy, orderBy, top, order, having } = body ?? {};
  if (!["count", "sum", "avg", "min", "max"].includes(op)) {
    return { status: 400, body: { error: "bad_request", detail: "op must be sum|count|avg|min|max" } };
  }
  if (column != null && !AGG_COL_RE.test(String(column))) return { status: 400, body: { error: "bad_column" } };
  if (groupBy != null && !AGG_COL_RE.test(String(groupBy))) return { status: 400, body: { error: "bad_groupby" } };
  if (orderBy != null && !AGG_ORDER_RE.test(String(orderBy))) return { status: 400, body: { error: "bad_orderby" } };
  if (op !== "count" && !column) {
    return { status: 400, body: { error: "bad_request", detail: `op ${op} needs a numeric column` } };
  }
  // Rank direction for grouped results (default desc = biggest first); asc
  // surfaces the bottom/smallest groups.
  if (order != null && order !== "asc" && order !== "desc") {
    return { status: 400, body: { error: "bad_order", detail: "order must be asc|desc" } };
  }
  const groupOrder = order === "asc" ? "asc" : "desc";
  // Optional post-fold filter on each group's aggregate value.
  let groupHaving = null;
  if (having != null) {
    if (
      typeof having !== "object" ||
      !HAVING_OPS.has(having.op) ||
      typeof having.value !== "number" ||
      !Number.isFinite(having.value)
    ) {
      return { status: 400, body: { error: "bad_having", detail: "having must be {op: eq|ne|gt|ge|lt|le, value: <number>}" } };
    }
    groupHaving = { op: having.op, value: having.value };
  }
  const flt = typeof filter === "string" && filter ? filter : undefined;
  const topN = Math.min(Math.max(1, parseInt(top, 10) || 10), 100);
  const base = `/data/erp/views/v1/${viewName}`;

  try {
    // --- exact COUNT, no scan: $inlinecount=allpages ---
    if (op === "count" && !groupBy) {
      const data = await p21Fetch(base, {
        searchParams: { "$top": 1, "$inlinecount": "allpages", "$filter": flt, "$select": column || orderBy || undefined },
      });
      const c = Number(data?.["odata.count"]);
      const ok = Number.isFinite(c);
      return { status: 200, body: { op, value: ok ? c : null, total_count: ok ? c : null, rows_scanned: 0, complete: ok } };
    }

    // --- exact MIN / MAX, no scan: $orderby <col> <dir> & $top=1 ---
    if ((op === "min" || op === "max") && !groupBy) {
      const dir = op === "max" ? "desc" : "asc";
      const data = await p21Fetch(base, {
        searchParams: { "$top": 1, "$orderby": `${column} ${dir}`, "$filter": flt, "$select": column },
      });
      const row = Array.isArray(data?.value) ? data.value[0] : undefined;
      return { status: 200, body: { op, column, value: row ? aggNum(row[column]) : null, rows_scanned: row ? 1 : 0, complete: true } };
    }

    // --- scan path: sum / avg / grouped. Page big, fold here, bounded. ---
    const projection = [groupBy, column].filter(Boolean);
    // A stable sort key is required for $skip paging (docs §Pagination). The app
    // passes the view's key column as orderBy; fall back to a projected column.
    const sortKey = typeof orderBy === "string" && orderBy ? orderBy : groupBy || column;

    // Exact population up front → drives page count + honest coverage.
    let total = null;
    {
      const ic = await p21Fetch(base, {
        searchParams: { "$top": 1, "$inlinecount": "allpages", "$filter": flt, "$select": projection[0] },
      });
      const c = Number(ic?.["odata.count"]);
      total = Number.isFinite(c) ? c : null;
    }
    const targetRows = total != null ? Math.min(total, AGG_MAX_ROWS) : AGG_MAX_ROWS;
    const nPages = Math.ceil(targetRows / AGG_PAGE);

    const fresh = () => ({ sum: 0, n: 0, min: Infinity, max: -Infinity, count: 0 });
    const groups = new Map();
    const ungrouped = fresh();
    const bump = (acc, val) => {
      acc.count++;
      if (val !== null) {
        acc.sum += val; acc.n++;
        if (val < acc.min) acc.min = val;
        if (val > acc.max) acc.max = val;
      }
    };

    const start = nowMs();
    let scanned = 0, timedOut = false, exhausted = false, errored = null, page = 0;
    while (page < nPages) {
      const wave = [];
      for (let k = 0; k < AGG_CONCURRENCY && page < nPages; k++, page++) {
        wave.push(
          p21Fetch(base, {
            searchParams: { "$top": AGG_PAGE, "$skip": page * AGG_PAGE, "$orderby": sortKey, "$filter": flt, "$select": projection.join(",") },
          }),
        );
      }
      let results;
      try { results = await Promise.all(wave); }
      catch (e) { errored = e; break; }
      for (const data of results) {
        const rows = Array.isArray(data?.value) ? data.value : [];
        for (const row of rows) {
          const val = column ? aggNum(row[column]) : null;
          if (groupBy) {
            const key = row[groupBy] == null ? "(null)" : String(row[groupBy]);
            let acc = groups.get(key);
            if (!acc) { acc = fresh(); groups.set(key, acc); }
            bump(acc, val);
          } else {
            bump(ungrouped, val);
          }
        }
        scanned += rows.length;
        if (rows.length < AGG_PAGE) exhausted = true; // reached the tail
      }
      if (exhausted) break;
      if (nowMs() - start > AGG_TIME_BUDGET_MS) { timedOut = true; break; }
    }
    if (errored) return mapError(errored);

    // Complete iff we covered the whole population: known total within the cap
    // and not timed out, or (unknown total) we hit a short tail page.
    const complete = !timedOut && (total != null ? total <= AGG_MAX_ROWS : exhausted);

    const out = { op, column, total_count: total, rows_scanned: scanned, complete };
    if (groupBy) {
      out.groupBy = groupBy;
      out.group_count = groups.size;
      const ranked = [...groups.entries()]
        .map(([key, acc]) => ({ key, value: aggReduce(op, acc), n: acc.count }))
        .filter((x) => x.value !== null)
        .filter((x) => havingPass(groupHaving, x.value));
      // When `having` filters the groups, expose how many matched (exact when
      // complete=true) so the caller can answer "how many items are dead/below
      // threshold" without re-deriving it from the truncated top-N list.
      if (groupHaving) out.groups_matching = ranked.length;
      out.order = groupOrder;
      out.groups = ranked
        .sort((a, b) => (groupOrder === "asc" ? a.value - b.value : b.value - a.value))
        .slice(0, topN);
    } else {
      out.value = aggReduce(op, ungrouped);
    }
    return { status: 200, body: out };
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
    if (!checkAuth(req)) {
      unauthorized(res);
      log("req", { method: req.method, path: url.pathname, status: 401, ms: nowMs() - started });
      return;
    }

    // Healthz is exempt from per-IP rate limit so monitoring probes keep
    // working under burst load. All other paths run through the bucket.
    if (url.pathname !== "/proxy/healthz") {
      const ip = clientIpFor(req);
      const rl = rateCheck(ip);
      if (!rl.ok) {
        send(res, 429, { error: "rate_limited" }, { "Retry-After": String(rl.retryAfterSec) });
        log("req", { method: req.method, path: url.pathname, status: 429, ms: nowMs() - started, ip });
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/proxy/healthz") {
      const tokenAge =
        cachedToken != null ? Math.round((nowMs() - cachedToken.mintedAt) / 1000) : null;
      const probe = await getProbeCached();
      send(res, 200, {
        ok: true,
        creds_present: CREDS_PRESENT,
        token_age_seconds: tokenAge,
        p21_reachable: cachedToken != null,
        token_ok: probe.token_ok,
        view_query_ok: probe.view_query_ok,
        last_error: probe.last_error,
        probe_latency_ms: probe.latency_ms,
        probe_age_seconds: Math.round((nowMs() - probe.at) / 1000),
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

    // POST /proxy/aggregate/:viewName
    const aggMatch = url.pathname.match(/^\/proxy\/aggregate\/([^/]+)$/);
    if (aggMatch && req.method === "POST") {
      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        send(res, 400, { error: "bad_request", detail: String(e.message ?? e) });
        log("req", { method: "POST", path: url.pathname, status: 400, ms: nowMs() - started });
        return;
      }
      const result = await handleAggregate(aggMatch[1], body);
      send(res, result.status, result.body);
      log("req", {
        method: "POST",
        path: url.pathname,
        status: result.status,
        ms: nowMs() - started,
        view: aggMatch[1],
        op: body?.op,
        rows_scanned: result.body?.rows_scanned,
        complete: result.body?.complete,
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
  // Cold-boot the P21 token so the first user request doesn't pay the mint
  // cost (~500ms). Best-effort — errors are logged but won't block startup.
  if (CREDS_PRESENT) {
    getP21Token().catch((e) =>
      log("prewarm_failed", { err: String(e?.message ?? e) }),
    );
  }
});

// Suppress the unused-import warning when keep-alive agents aren't wired
// through fetch — node:fetch uses undici under the hood, not these agents.
// They remain available for future direct-http upgrades and signal intent.
void dispatchAgent;

const shutdown = (sig) => {
  log("shutdown", { signal: sig });
  server.close(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
