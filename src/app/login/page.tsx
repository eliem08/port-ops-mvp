// Sign-in page: email + password (with TOTP step when enabled) and, when
// configured, single sign-on. Demo account emails are listed only while the
// database contains the synthetic demo seed.

import { listDemoUsers } from "@/lib/demo-users";
import { getDb } from "@/lib/db/client";
import { appName, demoDataPresent } from "@/lib/deployment";
import { oidcConfig } from "@/lib/oidc";
import { safeNextPath } from "@/lib/safe-redirect";
import { LoginForm } from "./login-form";

const SSO_ERRORS: Record<string, string> = {
  sso_denied: "Sign-in was cancelled at the identity provider.",
  sso_state_mismatch: "Your sign-in attempt expired or was tampered with. Please try again.",
  sso_failed: "Single sign-on failed. Please try again or contact an administrator.",
  sso_no_role: "Your account has no role in this application. Ask an administrator for access.",
  account_disabled: "This account is disabled.",
  sso_not_configured: "Single sign-on is not configured.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null);
  const errorCode = typeof params.error === "string" ? params.error : null;
  const sso = oidcConfig();
  const demoUsers = demoDataPresent(getDb()) ? listDemoUsers() : [];

  return (
    <div className="mx-auto max-w-md py-8">
      <h1 className="mb-1 text-xl font-bold text-ink">Sign in</h1>
      <p className="mb-6 text-sm text-muted">{appName()}</p>

      {errorCode && (
        <div role="alert" className="mb-4 rounded border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          {SSO_ERRORS[errorCode] ?? "Sign-in failed."}
        </div>
      )}

      {sso && (
        <>
          <a
            href={`/api/auth/oidc/login?next=${encodeURIComponent(next)}`}
            className="block w-full rounded bg-ink px-4 py-2.5 text-center text-sm font-medium text-white hover:opacity-90"
          >
            Sign in with {sso.providerName}
          </a>
          <div className="my-5 flex items-center gap-3 text-xs text-muted">
            <span className="h-px flex-1 bg-line" /> or use a local account <span className="h-px flex-1 bg-line" />
          </div>
        </>
      )}

      <LoginForm next={next} />

      {demoUsers.length > 0 && (
        <div className="mt-8 rounded border border-warn/50 bg-warn/10 px-4 py-3 text-sm">
          <p className="font-medium text-ink">Demo accounts (synthetic data)</p>
          <ul className="mt-2 space-y-1">
            {demoUsers.map((u) => (
              <li key={u.id} className="flex justify-between gap-3">
                <span className="font-mono text-xs">{u.email}</span>
                <span className="text-xs text-muted">{u.role}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">The demo password is printed by <code className="font-mono">npm run db:seed</code>.</p>
        </div>
      )}
    </div>
  );
}
