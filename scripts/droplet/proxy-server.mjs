#!/usr/bin/env node
// Olander P21 proxy. Vercel /api/chat tools call us at
//   POST https://egress.<domain>/proxy/<endpoint>
// We validate the inbound bearer, translate to a P21 REST call, return the
// response. Inherits the droplet's SNAT egress + /etc/hosts override, so the
// upstream call is a vanilla `fetch("https://<p21-host>/...")`.
//
// Bound to 127.0.0.1; reachable externally only via Caddy. Caddy forwards
// Authorization untouched — we re-check it here rather than in Caddy so the
// proxy can also be probed from loopback (healthcheck.sh).
//
// Zero-dep: Node 22 stdlib (http, crypto, native fetch). Ships with Ubuntu's
// `nodejs` package on 24.04 LTS.

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const TOKEN = (process.env.OLANDER_PROXY_TOKEN ?? "").trim();
const PORT = parseInt(process.env.PORT ?? "8089", 10);
const HOST = process.env.HOST ?? "127.0.0.1";

// Presence of *any* P21 credential env var flips creds_present. The actual
// auth pattern (bearer header vs session-mint via /api/security/Token) gets
// settled when the credentials arrive — see TODO(creds) below.
const CREDS_PRESENT = Boolean(
  process.env.P21_TOKEN || process.env.P21_USERNAME || process.env.P21_PASSWORD,
);

if (!TOKEN) {
  console.error("[proxy] OLANDER_PROXY_TOKEN is required");
  process.exit(1);
}

function checkAuth(req) {
  const header = req.headers["authorization"] ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice(7).trim(), "utf8");
  const expected = Buffer.from(TOKEN, "utf8");
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

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

async function searchInventory(query) {
  if (!CREDS_PRESENT) {
    const err = new Error("credentials_pending");
    err.code = "credentials_pending";
    throw err;
  }
  // TODO(creds): build the real P21 fetch using `query`. Network plumbing is
  // already in place — this runs from the droplet, so:
  //   1. SNAT means the hosting provider sees <proxy-ip>
  //   2. /etc/hosts maps <p21-host> → <p21-host-ip>
  // A literal fetch("https://<p21-host>/<endpoint>?q=...", { headers })
  // Just Works™. The header is the only open question. See docs/P21_Integration.md.
  console.log("[proxy] inventory_search query (not yet wired):", query);
  throw Object.assign(new Error("not_implemented"), { code: "not_implemented" });
}

const server = createServer(async (req, res) => {
  try {
    if (!checkAuth(req)) {
      unauthorized(res);
      return;
    }

    const url = new URL(req.url ?? "/", `http://${HOST}`);

    if (req.method === "GET" && url.pathname === "/proxy/healthz") {
      send(res, 200, { ok: true, creds_present: CREDS_PRESENT });
      return;
    }

    if (req.method === "POST" && url.pathname === "/proxy/inventory_search") {
      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        send(res, 400, { error: "bad_request", detail: String(e.message ?? e) });
        return;
      }
      const query = typeof body?.query === "string" ? body.query.trim() : "";
      if (!query) {
        send(res, 400, { error: "bad_request", detail: "body.query (string) is required" });
        return;
      }
      try {
        const data = await searchInventory(query);
        send(res, 200, data);
      } catch (e) {
        if (e.code === "credentials_pending") {
          send(res, 503, {
            error: "credentials_pending",
            detail: "Awaiting P21 play-env credentials",
          });
        } else {
          console.error("[proxy] inventory_search error:", e);
          send(res, 500, { error: "upstream_error" });
        }
      }
      return;
    }

    send(res, 404, { error: "not_found" });
  } catch (e) {
    console.error("[proxy] handler crashed:", e);
    if (!res.headersSent) send(res, 500, { error: "internal_error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[proxy] listening on ${HOST}:${PORT} (creds_present=${CREDS_PRESENT})`);
});

const shutdown = (sig) => {
  console.log(`[proxy] received ${sig}, shutting down`);
  server.close(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
