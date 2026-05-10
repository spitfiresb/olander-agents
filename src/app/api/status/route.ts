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

type DropletPayload = {
  latest: null | {
    checked_at: string;
    overall: "ok" | "degraded" | "down";
    checks: {
      egress_ip: DropletCheckResult;
      dns_override: DropletCheckResult;
      p21_reachable: DropletCheckResult;
    };
  };
  uptime: Record<"1h" | "24h" | "7d", { checks: number; ok: number; pct: number | null }>;
};

type ServiceCard = {
  id: string;
  name: string;
  description: string;
  state: ServiceState;
  message: string;
  checked_at: string | null;
  details?: Record<string, unknown>;
};

const FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url: string, init: RequestInit = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
  } finally {
    clearTimeout(t);
  }
}

async function fetchDroplet(): Promise<ServiceCard> {
  const base: ServiceCard = {
    id: "p21",
    name: "Olander API (P21)",
    description: "Egress droplet → P21 Prophet 21",
    state: "unknown",
    message: "Not configured",
    checked_at: null,
  };

  const url = process.env.DROPLET_HEALTH_URL;
  const token = process.env.DROPLET_HEALTH_TOKEN;
  if (!url || !token) {
    return { ...base, message: "DROPLET_HEALTH_URL/TOKEN not set" };
  }

  let payload: DropletPayload | null = null;
  try {
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return { ...base, state: "down", message: `Health endpoint returned HTTP ${res.status}` };
    }
    payload = (await res.json()) as DropletPayload;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...base, state: "down", message: `Could not reach health endpoint: ${msg}` };
  }

  const latest = payload.latest;
  if (!latest) {
    return { ...base, state: "unknown", message: "No checks recorded yet" };
  }

  const stateMap = { ok: "operational", degraded: "degraded", down: "down" } as const;
  const state: ServiceState = stateMap[latest.overall];

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
    message = failing.join(", ") || (state === "degraded" ? "Degraded" : "Down");
  }

  return {
    ...base,
    state,
    message,
    checked_at: latest.checked_at,
    details: {
      uptime: payload.uptime,
      checks: latest.checks,
    },
  };
}

async function fetchAnthropic(): Promise<ServiceCard> {
  const base: ServiceCard = {
    id: "anthropic",
    name: "Anthropic API",
    description: "Powers the chat assistant",
    state: "unknown",
    message: "—",
    checked_at: null,
  };

  try {
    const res = await fetchWithTimeout("https://status.anthropic.com/api/v2/status.json", {
      redirect: "follow",
    });
    if (!res.ok) {
      return { ...base, state: "down", message: `Anthropic status returned HTTP ${res.status}` };
    }
    const json = (await res.json()) as {
      page?: { updated_at?: string };
      status?: { indicator?: string; description?: string };
    };
    const indicator = json.status?.indicator ?? "none";
    const description = json.status?.description ?? "Unknown";

    const state: ServiceState =
      indicator === "none"
        ? "operational"
        : indicator === "minor" || indicator === "maintenance"
          ? "degraded"
          : indicator === "major" || indicator === "critical"
            ? "down"
            : "unknown";

    return {
      ...base,
      state,
      message: description,
      checked_at: json.page?.updated_at ?? null,
      details: { indicator },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...base, state: "unknown", message: `Could not reach Anthropic status: ${msg}` };
  }
}

export async function GET() {
  const [p21, anthropic] = await Promise.all([fetchDroplet(), fetchAnthropic()]);
  return NextResponse.json(
    { fetched_at: new Date().toISOString(), services: [p21, anthropic] },
    { headers: { "Cache-Control": "no-store" } },
  );
}
