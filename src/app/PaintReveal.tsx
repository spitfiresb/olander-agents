"use client";

import { useState } from "react";

interface Props {
  originX: number;
  originY: number;
}

// Each blob's `r` animates from 8px (a visible droplet at the button) up to
// a radius large enough to cover the viewport from its own center. Offsets
// are tight (±20px) so every blob reads as emerging FROM the button. The
// CSS `paint-grow` keyframes (in globals.css) use a strong ease-in, so the
// spread starts slow and visible and only accelerates into a full-screen
// flood once it's already on the way.
const BLOBS = [
  { dx:   0, dy:  0,  delay:   0, duration: 1800, seed:  7, freq: 0.009, disp: 110 },
  { dx: -18, dy: -6,  delay:  60, duration: 1750, seed: 13, freq: 0.012, disp:  95 },
  { dx:  20, dy: -4,  delay: 130, duration: 1850, seed: 23, freq: 0.014, disp: 100 },
  { dx: -14, dy:  7,  delay: 200, duration: 1700, seed: 31, freq: 0.010, disp: 105 },
  { dx:  16, dy:  8,  delay: 270, duration: 1650, seed: 41, freq: 0.013, disp:  90 },
  { dx:  -4, dy: -9,  delay: 330, duration: 1600, seed: 53, freq: 0.011, disp: 100 },
] as const;

export function PaintReveal({ originX, originY }: Props) {
  // Snapshot the viewport once on mount — PaintReveal only mounts after the
  // click (a client-only event), so `window` is always defined in practice.
  const [size] = useState<{ w: number; h: number } | null>(() => {
    if (typeof window === "undefined") return null;
    return { w: window.innerWidth, h: window.innerHeight };
  });

  if (!size) return null;
  const { w: vw, h: vh } = size;

  return (
    <div
      aria-hidden
      className="paint-reveal pointer-events-none fixed inset-0 z-[60] overflow-hidden"
    >
      <svg className="absolute inset-0 h-full w-full">
        <defs>
          {BLOBS.map((b, i) => (
            <filter
              key={i}
              id={`paint-noise-${i}`}
              x="-50%"
              y="-50%"
              width="200%"
              height="200%"
            >
              <feTurbulence
                type="fractalNoise"
                baseFrequency={b.freq}
                numOctaves={3}
                seed={b.seed}
                result="noise"
              />
              <feDisplacementMap in="SourceGraphic" in2="noise" scale={b.disp} />
            </filter>
          ))}
        </defs>
        {BLOBS.map((b, i) => {
          const cx = originX + b.dx;
          const cy = originY + b.dy;
          // The final radius for this blob: distance to its farthest corner,
          // plus the displacement spread, plus a little buffer. Every blob
          // independently grows large enough to cover the screen, so when
          // they're all at max they form a solid red mass with no gaps.
          const maxR =
            Math.sqrt(
              Math.max(cx, vw - cx) ** 2 + Math.max(cy, vh - cy) ** 2,
            ) +
            b.disp +
            60;
          return (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              fill="#EB402E"
              filter={`url(#paint-noise-${i})`}
              className="paint-blob"
              style={
                {
                  "--blob-r-to": `${maxR}px`,
                  animation: `paint-grow ${b.duration}ms cubic-bezier(0.55, 0.05, 0.85, 0.18) ${b.delay}ms both`,
                } as React.CSSProperties
              }
            />
          );
        })}
      </svg>
    </div>
  );
}
