import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type ServiceState = "operational" | "degraded" | "down" | "unknown";

type DropletCheckResult = {
  ok: boolean;
  value?: string;
  expected?: string;
  http_status?: number;
  latency_ms?: number;
};

type Day = {
  date: string; // YYYY-MM-DD (UTC)
  pct: number | null; // null = no data recorded that day
  checks?: number;
  ok?: number; // passing checks; (checks - ok) = ~minutes of downtime (1 check / 60s)
};

type Window = { checks: number; ok: number; pct: number | null };

type AnthropicCheck = {
  ok: boolean;
  indicator?: string;
  http_status?: number;
  latency_ms?: number;
};

type P21ApiCheck = {
  ok: boolean;
  token_ok?: boolean;
  view_query_ok?: boolean;
  last_error?: string;
  creds_present?: boolean;
};

type DropletPayload = {
  latest: null | {
    checked_at: string;
    overall: "ok" | "degraded" | "down";
    checks: {
      egress_ip: DropletCheckResult;
      dns_override: DropletCheckResult;
      p21_reachable: DropletCheckResult;
      tls_cert?: DropletCheckResult & { hours_until_expiry?: number; expires_at?: string };
      proxy_up?: DropletCheckResult & { creds_present?: boolean };
      anthropic?: AnthropicCheck;
      p21_api?: P21ApiCheck;
    };
  };
  uptime: Record<"1h" | "24h" | "7d", Window>;
  daily?: Day[];
  anthropic?: {
    uptime: Record<"1h" | "24h" | "7d", Window>;
    daily: Day[];
  };
  p21_api?: {
    uptime: Record<"1h" | "24h" | "7d", Window>;
    daily: Day[];
  };
};

type Service = {
  id: string;
  name: string;
  description: string;
  state: ServiceState;
  message: string;
  checked_at: string | null;
  uptime_pct: number | null; // headline uptime over the visible window
  days: Day[]; // 90 entries, oldest → newest (today last)
};

const FETCH_TIMEOUT_MS = 8000;
const WINDOW_DAYS = 90;

async function fetchWithTimeout(url: string, init: RequestInit = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
  } finally {
    clearTimeout(t);
  }
}

// Build a 90-element array of UTC dates, oldest → newest.
function emptyDays(): Day[] {
  const out: Day[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    out.push({ date: d.toISOString().slice(0, 10), pct: null });
  }
  return out;
}

// Merge whatever the droplet returned into a 90-day window. If the droplet
// hasn't been upgraded to expose `daily` yet, we fall back to filling only
// "today" from the latest aggregate so the bar isn't entirely empty.
function buildDays(payload: DropletPayload | null): Day[] {
  const days = emptyDays();
  if (!payload) return days;
  const byDate = new Map(days.map((d, i) => [d.date, i]));

  if (Array.isArray(payload.daily)) {
    for (const d of payload.daily) {
      const i = byDate.get(d.date);
      if (i !== undefined) days[i] = { ...days[i], pct: d.pct, checks: d.checks, ok: d.ok };
    }
    return days;
  }

  // Fallback: stamp today's cell using the 24h aggregate.
  const todayPct = payload.uptime?.["24h"]?.pct ?? null;
  if (todayPct !== null) {
    days[days.length - 1] = { ...days[days.length - 1], pct: todayPct };
  }
  return days;
}

function indicatorToState(indicator: string | undefined): ServiceState {
  if (!indicator || indicator === "unknown") return "unknown";
  if (indicator === "none") return "operational";
  if (indicator === "minor" || indicator === "maintenance") return "degraded";
  if (indicator === "major" || indicator === "critical") return "down";
  return "unknown";
}

function buildAnthropicDays(payload: DropletPayload | null): Day[] {
  const days = emptyDays();
  if (!payload?.anthropic?.daily) return days;
  const byDate = new Map(days.map((d, i) => [d.date, i]));
  for (const d of payload.anthropic.daily) {
    const i = byDate.get(d.date);
    if (i !== undefined) days[i] = { ...days[i], pct: d.pct, checks: d.checks, ok: d.ok };
  }
  return days;
}

function buildP21ApiDays(payload: DropletPayload | null): Day[] {
  const days = emptyDays();
  if (!payload?.p21_api?.daily) return days;
  const byDate = new Map(days.map((d, i) => [d.date, i]));
  for (const d of payload.p21_api.daily) {
    const i = byDate.get(d.date);
    if (i !== undefined) days[i] = { ...days[i], pct: d.pct, checks: d.checks, ok: d.ok };
  }
  return days;
}

async function fetchDropletPayload(): Promise<{
  payload: DropletPayload | null;
  error: string | null;
}> {
  const url = process.env.DROPLET_HEALTH_URL;
  const token = process.env.DROPLET_HEALTH_TOKEN;
  if (!url || !token) {
    return { payload: null, error: "DROPLET_HEALTH_URL/TOKEN not set" };
  }
  try {
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return { payload: null, error: `Health endpoint returned HTTP ${res.status}` };
    }
    return { payload: (await res.json()) as DropletPayload, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { payload: null, error: `Could not reach health endpoint: ${msg}` };
  }
}

function buildP21Service(
  payload: DropletPayload | null,
  error: string | null,
): Service {
  const base: Service = {
    id: "p21",
    name: "P21 connection",
    description: "End-to-end check from our egress droplet to P21",
    state: "unknown",
    message: "Not configured",
    checked_at: null,
    uptime_pct: null,
    days: emptyDays(),
  };
  if (error) {
    return { ...base, state: "down", message: error };
  }
  if (!payload) {
    return base;
  }
  const latest = payload.latest;
  if (!latest) {
    return { ...base, message: "No checks recorded yet" };
  }
  const stateMap = { ok: "operational", degraded: "degraded", down: "down" } as const;
  const state: ServiceState = stateMap[latest.overall];

  // Symbolic labels only — never expose IPs/URLs from latest.checks.
  let message: string;
  if (state === "operational") {
    message = "All checks passing";
  } else {
    const failing: string[] = [];
    if (!latest.checks.egress_ip.ok) failing.push("egress IP mismatch");
    if (!latest.checks.dns_override.ok) failing.push("DNS override missing");
    if (!latest.checks.p21_reachable.ok) {
      const code = latest.checks.p21_reachable.http_status;
      failing.push(code ? `P21 HTTP ${code}` : "P21 unreachable");
    }
    if (latest.checks.tls_cert && !latest.checks.tls_cert.ok) failing.push("TLS cert near expiry");
    if (latest.checks.proxy_up && !latest.checks.proxy_up.ok) failing.push("Layer 2 proxy down");
    message = failing.join(", ") || (state === "degraded" ? "Degraded" : "Down");
  }

  const days = buildDays(payload);
  return {
    ...base,
    state,
    message,
    checked_at: latest.checked_at,
    uptime_pct: computeWindowPct(days),
    days,
  };
}

async function buildAnthropicService(
  payload: DropletPayload | null,
): Promise<Service> {
  const base: Service = {
    id: "anthropic",
    name: "Anthropic API",
    description: "Powers the chat assistant",
    state: "unknown",
    message: "—",
    checked_at: null,
    uptime_pct: null,
    days: emptyDays(),
  };

  // Preferred path: the droplet observed Anthropic in its last check.
  const latestAnth = payload?.latest?.checks?.anthropic;
  if (latestAnth) {
    const state = indicatorToState(latestAnth.indicator);
    const days = buildAnthropicDays(payload);
    return {
      ...base,
      state,
      message: latestAnth.ok
        ? "All systems operational"
        : `Status: ${latestAnth.indicator ?? "unknown"}`,
      checked_at: payload?.latest?.checked_at ?? null,
      uptime_pct: computeWindowPct(days),
      days,
    };
  }

  // Fallback: hit Anthropic's status API directly. Used during the deploy
  // window before the updated healthcheck has run on the droplet, or if the
  // droplet is unreachable.
  try {
    const res = await fetchWithTimeout(
      "https://status.anthropic.com/api/v2/status.json",
      { redirect: "follow" },
    );
    if (!res.ok) {
      return { ...base, state: "down", message: `Anthropic status returned HTTP ${res.status}` };
    }
    const json = (await res.json()) as {
      page?: { updated_at?: string };
      status?: { indicator?: string; description?: string };
    };
    const state = indicatorToState(json.status?.indicator);
    const days = emptyDays();
    days[days.length - 1] = {
      ...days[days.length - 1],
      pct: state === "operational" ? 100 : state === "degraded" ? 95 : 50,
    };
    return {
      ...base,
      state,
      message: json.status?.description ?? "Unknown",
      checked_at: json.page?.updated_at ?? null,
      days,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...base, state: "unknown", message: `Could not reach Anthropic status: ${msg}` };
  }
}

function buildP21ApiService(
  payload: DropletPayload | null,
  error: string | null,
): Service {
  const base: Service = {
    id: "p21_api",
    name: "P21 API",
    description: "Token mint and Data Services view query",
    state: "unknown",
    message: "Not configured",
    checked_at: null,
    uptime_pct: null,
    days: emptyDays(),
  };
  if (error) {
    return { ...base, state: "down", message: error };
  }
  if (!payload) return base;
  const latest = payload.latest;
  if (!latest) {
    return { ...base, message: "No checks recorded yet" };
  }
  const api = latest.checks.p21_api;
  // Pre-upgrade droplet: field absent. Render unknown rather than down so the
  // deploy window (Vercel ahead of droplet) doesn't false-alarm.
  if (!api) {
    return { ...base, message: "Awaiting upgraded droplet", checked_at: latest.checked_at };
  }
  // Creds absent: probe didn't run. Surface as unknown, not down.
  if (api.creds_present === false) {
    return {
      ...base,
      message: "P21 credentials not configured",
      checked_at: latest.checked_at,
    };
  }

  const days = buildP21ApiDays(payload);
  let state: ServiceState;
  let message: string;
  if (api.token_ok && api.view_query_ok) {
    state = "operational";
    message = "Token mint and view query OK";
  } else if (!api.token_ok) {
    state = "degraded";
    message = api.last_error
      ? `Token mint failed: ${api.last_error}`
      : "Token mint failed";
  } else {
    state = "degraded";
    message = api.last_error
      ? `View query failed: ${api.last_error}`
      : "View query failed";
  }
  return {
    ...base,
    state,
    message,
    checked_at: latest.checked_at,
    uptime_pct: computeWindowPct(days),
    days,
  };
}

function computeWindowPct(days: Day[]): number | null {
  const real = days.filter((d) => d.pct !== null);
  if (real.length === 0) return null;
  const sum = real.reduce((acc, d) => acc + (d.pct ?? 0), 0);
  return sum / real.length;
}

export async function GET() {
  const { payload, error } = await fetchDropletPayload();
  const p21 = buildP21Service(payload, error);
  const p21Api = buildP21ApiService(payload, error);
  const anthropic = await buildAnthropicService(payload);
  return NextResponse.json(
    { fetched_at: new Date().toISOString(), services: [p21, p21Api, anthropic] },
    { headers: { "Cache-Control": "no-store" } },
  );
}
