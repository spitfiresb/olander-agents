import { ImageResponse } from "next/og";

// Static OG image (renders at build time per Next.js conventions).
// Sized to the OG default (1200x630) — fits Twitter's large-card slot too.
export const runtime = "edge";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Olander Agents — internal AI assistant for the Olander team";

const RED = "#EB402E";
const CANVAS = "#FAF7F1";
const CHARCOAL = "#2D2E29";
const INK_SOFT = "#4A4B46";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: CANVAS,
          color: CHARCOAL,
          display: "flex",
          flexDirection: "column",
          padding: "72px 80px",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              background: RED,
              color: "#FFFFFF",
              fontWeight: 900,
              letterSpacing: 2,
              fontSize: 36,
              padding: "10px 18px",
              borderRadius: 6,
              display: "flex",
            }}
          >
            OLANDER
          </div>
          <div style={{ fontSize: 36, color: CHARCOAL }}>Agents</div>
        </div>

        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Satori (next/og) requires display: flex/contents/none on any
              element with more than one child node. We split the heading
              into two stacked divs instead of using <br/>. */}
          <div style={{ display: "flex", flexDirection: "column", fontSize: 64, fontWeight: 700, lineHeight: 1.05 }}>
            <span>A faster brain for Olander&rsquo;s</span>
            <span>inside-sales team.</span>
          </div>
          <div style={{ display: "flex", fontSize: 28, color: INK_SOFT }}>
            Catalog, inventory, customer history — answered in a sentence.
          </div>
        </div>
      </div>
    ),
    {
      ...size,
    },
  );
}
