// Next.js startup hook — runs once when the server boots (not per request).
// This is where the demo's non-negotiable startup checks live.
//
// 1. PRODUCTION SECRET CHECK: refuses to boot in production without
//    DEMO_AUTH_SECRET. The check lives here (not lazily in the auth module)
//    so a misconfigured production deploy fails fast and loudly at startup
//    instead of serving forgeable sessions until the first login attempt.
//    (getSecretBytes() also throws defensively on every use.)
// 2. DEMO BANNER: prints the demo-auth limitations to the server log on
//    every boot so no operator can mistake this for production auth.

import { getSecretBytes } from "./lib/auth-secret";

export async function register(): Promise<void> {
  // Fail fast in production without a real secret. In dev/test this warns.
  getSecretBytes();

  const isProd = process.env.NODE_ENV === "production";
  console.warn(
    [
      "═══════════════════════════════════════════════════════════════",
      "  PORT-OPS-MVP — DEMO AUTHENTICATION (NOT production auth)",
      `  Mode: ${isProd ? "PRODUCTION (demo auth still active — do not expose)" : "development"}`,
      "  Demo identities are passwordless and PUBLIC (listed on /login).",
      "  Sessions: signed JWT in httpOnly cookie, 8h absolute expiry.",
      "  Still missing for production: password hashing, MFA, account",
      "  recovery, session revocation, brute-force lockout, audit shipping.",
      "  See docs/LIMITATIONS.md #2. Do not present this as secure login.",
      "═══════════════════════════════════════════════════════════════",
    ].join("\n")
  );
}
