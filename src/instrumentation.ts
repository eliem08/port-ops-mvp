// Next.js startup hook — runs once when the server boots (not per request).
//
// 1. PRODUCTION SECRET CHECK: refuses to boot in production without a strong
//    AUTH_SECRET, so a misconfigured deploy fails fast at startup instead of
//    serving forgeable sessions. (getSecretBytes() also throws on every use.)
// 2. CONFIGURATION SUMMARY: logs the security-relevant settings (never their
//    values) so operators can confirm what is active.

import { getSecretBytes } from "./lib/auth-secret";

export async function register(): Promise<void> {
  getSecretBytes();

  const env = process.env;
  // register() runs once per runtime (Node and edge); report from Node only.
  if (env.NEXT_RUNTIME === "edge") return;
  const sso = Boolean(env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET);
  console.info(
    JSON.stringify({
      level: "info",
      msg: "server starting",
      mode: env.NODE_ENV ?? "development",
      auth: {
        password: true,
        sso: sso ? env.OIDC_ISSUER : false,
        mfaRequiredRoles: env.MFA_REQUIRED_ROLES ?? "administrator",
        sessionTtlHours: Number(env.SESSION_TTL_HOURS) > 0 ? Number(env.SESSION_TTL_HOURS) : 8,
        dedicatedDataKey: Boolean(env.DATA_ENCRYPTION_KEY),
      },
      metrics: Boolean(env.METRICS_TOKEN),
      auditWebhook: Boolean(env.AUDIT_WEBHOOK_URL),
    })
  );

  // Migrations, admin bootstrap, scheduled backups, audit shipping — Node
  // runtime only (they need SQLite), and never during `next build`.
  if (env.NEXT_RUNTIME === "nodejs" && env.NEXT_PHASE !== "phase-production-build") {
    const [{ runStartupTasks }, { getDb }] = await Promise.all([
      import("./lib/startup"),
      import("./lib/db/client"),
    ]);
    runStartupTasks(getDb);
  }
}
