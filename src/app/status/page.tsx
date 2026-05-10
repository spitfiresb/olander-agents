"use client";

import { useCallback, useEffect, useState } from "react";
import { Wordmark } from "@/components/Wordmark";

type ServiceState = "operational" | "degraded" | "down" | "unknown";

type UptimeWindow = { checks: number; ok: number; pct: number | null };

type Service = {
  id: string;
  name: string;
  description: string;
  state: ServiceState;
  message: string;
  checked_at: string | null;
  details?: {
    uptime?: Record<"1h" | "24h" | "7d", UptimeWindow>;
    indicator?: string;
  };
};

type StatusPayload = {
  fetched_at: string;
  services: Service[];
};

const POLL_INTERVAL_MS = 30_000;

export default function StatusPage() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as StatusPayload;
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(refresh, 0);
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [refresh]);

  const overall = deriveOverall(data?.services);

  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-brand-canvas">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-2/3"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 50% 0%, rgba(228, 217, 197, 0.55) 0%, transparent 70%)",
        }}
      />
      <main className="relative mx-auto w-full max-w-3xl flex-1 px-6 py-12">
        <header className="mb-10 flex flex-col items-center text-center">
          <Wordmark variant="hero" />
          <h1 className="mt-6 text-2xl font-semibold tracking-tight text-brand-charcoal">
            Service status
          </h1>
          <p className="mt-2 text-sm text-brand-ink-soft">
            Live health of the systems Olander Agents depends on.
          </p>
        </header>

        <div className="mb-6 flex items-center justify-between rounded-2xl border border-brand-charcoal/10 bg-white px-5 py-4">
          <div className="flex items-center gap-3">
            <StatusDot state={overall} />
            <div>
              <div className="text-sm font-semibold text-brand-charcoal">
                {OVERALL_LABEL[overall]}
              </div>
              <div className="text-xs text-brand-ink-soft">
                {data ? `Last refreshed ${formatRelative(data.fetched_at)}` : "Loading…"}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="rounded-full border border-brand-charcoal/15 bg-white px-3 py-1 text-xs text-brand-charcoal transition-colors hover:border-brand-charcoal/30 hover:bg-brand-sand/40 disabled:opacity-50"
          >
            Refresh
          </button>
        </div>

        {error && !data && (
          <div className="rounded-lg border border-brand-red/30 bg-white px-4 py-3 text-sm text-brand-charcoal">
            Could not load status: {error}
          </div>
        )}

        <div className="space-y-4">
          {data?.services.map((service) => (
            <ServiceCard key={service.id} service={service} />
          ))}
          {!data && loading && <SkeletonCard />}
        </div>

        <p className="mt-10 text-center text-xs text-brand-ink-soft">
          Checks run every 60 seconds on the egress droplet. This page polls every 30 seconds.
        </p>
      </main>
    </div>
  );
}

function ServiceCard({ service }: { service: Service }) {
  const uptime = service.details?.uptime;
  return (
    <article className="rounded-2xl border border-brand-charcoal/10 bg-white p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-brand-charcoal">{service.name}</h2>
          <p className="mt-0.5 text-xs text-brand-ink-soft">{service.description}</p>
        </div>
        <StatusPill state={service.state} />
      </div>

      <p className="mt-3 text-sm text-brand-charcoal">{service.message}</p>

      {uptime && (
        <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-brand-charcoal/5 pt-4">
          {(["1h", "24h", "7d"] as const).map((window) => (
            <UptimeCell key={window} label={window} window={uptime[window]} />
          ))}
        </dl>
      )}

      {service.checked_at && (
        <div className="mt-4 text-xs text-brand-ink-soft">
          Last checked {formatRelative(service.checked_at)}
        </div>
      )}
    </article>
  );
}

function UptimeCell({ label, window: w }: { label: string; window: UptimeWindow }) {
  const display = w.pct === null ? "—" : `${w.pct.toFixed(w.pct === 100 ? 0 : 2)}%`;
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-brand-ink-soft">Last {label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums text-brand-charcoal">{display}</dd>
      <div className="text-[11px] text-brand-ink-soft">
        {w.ok}/{w.checks} checks
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-2xl border border-brand-charcoal/10 bg-white p-5">
      <div className="h-4 w-40 animate-pulse rounded bg-brand-canvas" />
      <div className="mt-3 h-3 w-3/4 animate-pulse rounded bg-brand-canvas" />
    </div>
  );
}

function StatusDot({ state }: { state: ServiceState }) {
  return (
    <span
      aria-hidden
      className="inline-block h-2.5 w-2.5 rounded-full"
      style={{ backgroundColor: STATE_COLOR[state] }}
    />
  );
}

function StatusPill({ state }: { state: ServiceState }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-brand-charcoal/15 bg-white px-2.5 py-1 text-xs text-brand-charcoal">
      <StatusDot state={state} />
      {STATE_LABEL[state]}
    </span>
  );
}

const STATE_COLOR: Record<ServiceState, string> = {
  operational: "#16A34A",
  degraded: "#D97706",
  down: "#EB402E",
  unknown: "#9CA3AF",
};

const STATE_LABEL: Record<ServiceState, string> = {
  operational: "Operational",
  degraded: "Degraded",
  down: "Down",
  unknown: "Unknown",
};

const OVERALL_LABEL: Record<ServiceState, string> = {
  operational: "All systems operational",
  degraded: "Some systems degraded",
  down: "Service disruption",
  unknown: "Status unavailable",
};

function deriveOverall(services: Service[] | undefined): ServiceState {
  if (!services || services.length === 0) return "unknown";
  if (services.some((s) => s.state === "down")) return "down";
  if (services.some((s) => s.state === "degraded")) return "degraded";
  if (services.every((s) => s.state === "operational")) return "operational";
  return "unknown";
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}
