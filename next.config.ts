import type { NextConfig } from "next";

// Baseline security headers for the demo. CSP is deliberately pragmatic
// rather than locked-down: Next.js dev/HMR needs 'unsafe-eval', and the app
// router inlines scripts/styles, so a strict nonce-based policy would break
// the framework. This blocks clickjacking (DENY + frame-ancestors 'none'),
// MIME sniffing, and referrer leakage — good enough for a demo, NOT a
// hardened production policy.
const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
];

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module — keep it server-side only
  serverExternalPackages: ["better-sqlite3"],
  async headers() {
    return [
      {
        // Applies to pages and API routes (not _next/static assets, which
        // don't need them and are immutable-hashed anyway).
        source: "/((?!_next/static|_next/image).*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
