"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/Logo";

type ServiceState = "operational" | "degraded" | "down" | "unknown";

type Day = {
  date: string;
  pct: number | null;
  checks?: number;
  ok?: number;
};

type Service = {
  id: string;
  name: string;
  description: string;
  state: ServiceState;
  message: string;
  checked_at: string | null;
  uptime_pct: number | null;
  days: Day[];
};

type StatusPayload = {
  fetched_at: string;
  services: Service[];
};

// Match the droplet's healthcheck cadence — polling faster just gives us
// the same data twice. The droplet's /health response is cached for 30s, so
// 60s polling always hits fresh data.
const POLL_INTERVAL_MS = 60_000;
const BAR_COUNT = 90;

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
    <div className="min-h-dvh bg-brand-canvas">
      <main className="mx-auto w-full max-w-4xl px-6 py-10 sm:py-14">
        <header className="mb-12">
          <Link href="/chat" className="flex items-center gap-3">
            <Logo size="sm" />
            <span className="text-lg font-medium text-brand-charcoal">
              Agents Status
            </span>
          </Link>
        </header>

        <section
          className="mb-10 rounded-md px-6 py-5 text-white"
          style={{ backgroundColor: BANNER_COLOR[overall] }}
        >
          <h1 className="text-xl font-semibold sm:text-2xl">
            {OVERALL_LABEL[overall]}
          </h1>
        </section>

        {error && !data && (
          <div className="mb-6 rounded-md border border-brand-red/30 bg-white px-4 py-3 text-sm text-brand-charcoal">
            Could not load status: {error}
          </div>
        )}

        <div className="mb-3 flex justify-end text-xs text-brand-ink-soft">
          Uptime over the past 90 days.
        </div>

        <section className="space-y-3">
          {data?.services.map((service) => (
            <ServiceCard key={service.id} service={service} />
          ))}
          {!data && loading && <SkeletonCard />}
        </section>

      </main>
    </div>
  );
}

function ServiceCard({ service }: { service: Service }) {
  return (
    <article className="rounded-md border border-brand-charcoal/10 bg-white px-5 py-5 sm:px-6">
      <div className="mb-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-1.5">
          <h2 className="text-[15px] font-semibold text-brand-charcoal">
            {service.name}
          </h2>
          <InfoButton description={service.description} />
        </div>
        <span
          className="text-sm font-medium"
          style={{ color: STATE_TEXT_COLOR[service.state] }}
        >
          {STATE_LABEL[service.state]}
        </span>
      </div>
      <UptimeBar service={service} />
      {service.state !== "operational" && service.message && (
        <p className="mt-3 text-sm text-brand-charcoal">{service.message}</p>
      )}
    </article>
  );
}

function InfoButton({ description }: { description: string }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={wrapRef} className="relative inline-flex">
      <button
        type="button"
        aria-label="What does this check?"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-brand-ink-soft transition-colors hover:text-brand-charcoal focus-visible:text-brand-charcoal focus-visible:outline-none"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1" />
          <text
            x="8"
            y="11.5"
            textAnchor="middle"
            fontSize="9"
            fontWeight="600"
            fill="currentColor"
          >
            ?
          </text>
        </svg>
      </button>
      {open && (
        <div
          role="tooltip"
          className="absolute left-full top-1/2 z-10 ml-2 w-max max-w-xs -translate-y-1/2 whitespace-normal rounded-md border border-brand-charcoal/15 bg-white px-3 py-2 text-xs text-brand-ink-soft shadow-sm"
        >
          {description}
        </div>
      )}
    </span>
  );
}

type Tooltip = {
  x: number;
  y: number;
  date: string;
  pct: number | null;
  checks?: number;
  ok?: number;
};

function UptimeBar({ service }: { service: Service }) {
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Pad/truncate the days array to BAR_COUNT just in case.
  const cells: Day[] =
    service.days.length === BAR_COUNT
      ? service.days
      : Array.from(
          { length: BAR_COUNT },
          (_, i) =>
            service.days[i + Math.max(0, service.days.length - BAR_COUNT)] ?? {
              date: "",
              pct: null,
            },
        );

  const realCells = cells.filter((c) => c.pct !== null);
  const uptimePct =
    realCells.length > 0
      ? realCells.reduce((acc, c) => acc + (c.pct ?? 0), 0) / realCells.length
      : null;

  const handleMove = (e: React.MouseEvent<SVGRectElement>, day: Day) => {
    const cont = containerRef.current?.getBoundingClientRect();
    if (!cont) return;
    const rect = (e.target as SVGRectElement).getBoundingClientRect();
    setTooltip({
      x: rect.left - cont.left + rect.width / 2,
      y: rect.top - cont.top,
      date: day.date,
      pct: day.pct,
      checks: day.checks,
      ok: day.ok,
    });
  };

  return (
    <div ref={containerRef} className="relative">
      <svg
        viewBox={`0 0 ${BAR_COUNT * 5 - 2} 34`}
        preserveAspectRatio="none"
        className="block h-[34px] w-full"
        onMouseLeave={() => setTooltip(null)}
      >
        {cells.map((day, i) => (
          <rect
            key={`${day.date}-${i}`}
            x={i * 5}
            y={0}
            width={3}
            height={34}
            fill={uptimeColor(day.pct)}
            onMouseEnter={(e) => handleMove(e, day)}
            onMouseMove={(e) => handleMove(e, day)}
          />
        ))}
      </svg>
      <div className="mt-2 grid grid-cols-3 items-center text-[11px] text-brand-ink-soft">
        <span className="justify-self-start">90 days ago</span>
        <span className="justify-self-center text-center">
          {uptimePct === null
            ? "— uptime"
            : `${uptimePct.toFixed(uptimePct === 100 ? 0 : 2)} % uptime`}
        </span>
        <span className="justify-self-end">Today</span>
      </div>

      {tooltip && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-brand-charcoal/15 bg-white px-3 py-2 text-xs shadow-sm"
          style={{ left: tooltip.x, top: tooltip.y - 6 }}
        >
          <div className="font-semibold text-brand-charcoal">
            {formatTooltipDate(tooltip.date)}
          </div>
          {tooltip.pct === null ? (
            <div className="mt-0.5 text-brand-ink-soft">No data recorded for this day.</div>
          ) : tooltip.pct >= 100 ? (
            <div className="mt-0.5 text-brand-ink-soft">No downtime recorded on this day.</div>
          ) : tooltip.checks != null &&
            tooltip.ok != null &&
            tooltip.checks > tooltip.ok ? (
            <OutageCard
              minutes={tooltip.checks - tooltip.ok}
              severity={tooltip.pct < 90 ? "major" : "partial"}
            />
          ) : (
            <div className="mt-0.5 text-brand-ink-soft">{tooltip.pct.toFixed(2)} % uptime</div>
          )}
        </div>
      )}
    </div>
  );
}

function OutageCard({
  minutes,
  severity,
}: {
  minutes: number;
  severity: "partial" | "major";
}) {
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const isMajor = severity === "major";
  const palette = isMajor
    ? { bg: "bg-red-50", border: "border-red-200", icon: "text-red-500" }
    : { bg: "bg-amber-50", border: "border-amber-200", icon: "text-amber-500" };
  const label = isMajor ? "Major outage" : "Partial outage";
  return (
    <div
      className={`mt-2 flex items-center gap-2 rounded-md border ${palette.border} ${palette.bg} px-2.5 py-1.5`}
    >
      <span className={`flex h-4 w-4 items-center justify-center ${palette.icon}`} aria-hidden>
        {isMajor ? (
          <svg viewBox="0 0 14 14" className="h-3.5 w-3.5">
            <circle cx="7" cy="7" r="6.5" fill="currentColor" />
            <path
              d="M4.6 4.6 L9.4 9.4 M9.4 4.6 L4.6 9.4"
              stroke="white"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 14 14" className="h-3.5 w-3.5">
            <path d="M7 1 L13.2 12 L0.8 12 Z" fill="currentColor" />
            <rect x="6.45" y="5" width="1.1" height="3.6" fill="white" rx="0.3" />
            <circle cx="7" cy="10.2" r="0.65" fill="white" />
          </svg>
        )}
      </span>
      <span className="font-medium text-brand-charcoal">{label}</span>
      <span className="ml-2 text-brand-ink-soft tabular-nums">
        {hrs} {hrs === 1 ? "hr" : "hrs"}
        {"  "}
        {mins} {mins === 1 ? "min" : "mins"}
      </span>
    </div>
  );
}

function SkeletonCard() {
  return (
    <article className="rounded-md border border-brand-charcoal/10 bg-white px-5 py-5">
      <div className="mb-3 h-4 w-40 animate-pulse rounded bg-brand-canvas" />
      <div className="h-[34px] w-full animate-pulse rounded bg-brand-canvas" />
    </article>
  );
}

// Color stops picked to match status.claude.com:
//   100%  -> #76ad2a (operational green)
//   ~99%  -> #c3a92a (olive)
//   ~97%  -> #f08030 (orange)
//   <90%  -> #e04343 (red)
//   null  -> #d3d3d3 (no data)
function uptimeColor(pct: number | null): string {
  if (pct === null || pct === undefined) return "#d3d3d3";
  if (pct >= 100) return "#76ad2a";
  if (pct >= 99) return interpolateHex("#76ad2a", "#c3a92a", (100 - pct) / 1);
  if (pct >= 97) return interpolateHex("#c3a92a", "#f08030", (99 - pct) / 2);
  if (pct >= 90) return interpolateHex("#f08030", "#e04343", (97 - pct) / 7);
  return "#e04343";
}

function interpolateHex(a: string, b: string, t: number): string {
  const clamp = Math.max(0, Math.min(1, t));
  const ar = parseInt(a.slice(1, 3), 16);
  const ag = parseInt(a.slice(3, 5), 16);
  const ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16);
  const bg = parseInt(b.slice(3, 5), 16);
  const bb = parseInt(b.slice(5, 7), 16);
  const r = Math.round(ar + (br - ar) * clamp);
  const g = Math.round(ag + (bg - ag) * clamp);
  const bch = Math.round(ab + (bb - ab) * clamp);
  return `#${[r, g, bch].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function formatTooltipDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

const STATE_LABEL: Record<ServiceState, string> = {
  operational: "Operational",
  degraded: "Degraded",
  down: "Outage",
  unknown: "Unknown",
};

const STATE_TEXT_COLOR: Record<ServiceState, string> = {
  operational: "#76ad2a",
  degraded: "#d97706",
  down: "#eb402e",
  unknown: "#6b7280",
};

const BANNER_COLOR: Record<ServiceState, string> = {
  operational: "#7fa744",
  degraded: "#d97706",
  down: "#eb402e",
  unknown: "#6b7280",
};

const OVERALL_LABEL: Record<ServiceState, string> = {
  operational: "All Systems Operational",
  degraded: "Some Systems Degraded",
  down: "Service Disruption",
  unknown: "Status Unavailable",
};

function deriveOverall(services: Service[] | undefined): ServiceState {
  if (!services || services.length === 0) return "unknown";
  if (services.some((s) => s.state === "down")) return "down";
  if (services.some((s) => s.state === "degraded")) return "degraded";
  if (services.every((s) => s.state === "operational")) return "operational";
  return "unknown";
}

