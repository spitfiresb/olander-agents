import type { NextConfig } from "next";

// Conservative CSP for an internal chat product:
//   - Scripts: self only (Next.js inlines hydration bootstrap as a nonce-less
//     inline script, so 'unsafe-inline' is required for App Router until
//     Next ships nonce support across the framework's own scripts).
//   - Connect: self plus Anthropic API endpoints for streamed responses.
//   - Img: self + data: for inline SVG, plus the Microsoft Graph CDN for
//     account photos.
//   - Frames: none.
//
// If a future feature needs an additional origin, narrow it — never relax to
// `*`.
// React's dev mode uses eval() to reconstruct call stacks for prettier errors.
// In production React never calls eval, so the strict CSP is correct. In dev
// we relax script-src to 'unsafe-eval' to silence the runtime warning and
// keep React DevTools features working.
const isDev = process.env.NODE_ENV !== "production";

const scriptSrc = isDev
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";

const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "img-src 'self' data: https://graph.microsoft.com",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  scriptSrc,
  "connect-src 'self' https://api.anthropic.com",
  "upgrade-insecure-requests",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  devIndicators: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
