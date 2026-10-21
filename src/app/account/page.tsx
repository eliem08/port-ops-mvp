// Account & security: password, authenticator app (TOTP) and active sessions.
// Restricted sessions land here until the required setup step is done.

import { redirect } from "next/navigation";
import { getSession, mfaRequiredForRole } from "@/lib/auth";
import { listActiveSessions } from "@/lib/accounts";
import { getDb } from "@/lib/db/client";
import { Card } from "@/components/ui";
import { PasswordForm, MfaPanel, SessionsPanel } from "./account-forms";

export default async function AccountPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const sessions = listActiveSessions(getDb(), session.userId).map((s) => ({
    ...s,
    current: s.id === session.sessionId,
  }));
  const sso = session.authMethod === "oidc";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink">Account &amp; security</h1>
        <p className="text-sm text-muted">
          {session.label} · {session.email ?? "no email"} · role <span className="font-mono">{session.role}</span>
        </p>
      </div>

      {session.restricted && (
        <div role="alert" className="rounded border-2 border-warn bg-warn/10 px-4 py-3 text-sm text-ink">
          {session.restricted === "must_change_password"
            ? "Set a new password to continue. Your administrator issued a temporary one."
            : "Your role requires multi-factor authentication. Enroll an authenticator app below to continue."}
        </div>
      )}

      {sso ? (
        <Card title="Sign-in">
          <p className="text-sm text-muted">
            You signed in through single sign-on. Password and multi-factor settings are managed by your identity provider.
          </p>
        </Card>
      ) : (
        <>
          <Card title="Password">
            <PasswordForm />
          </Card>
          <Card title="Authenticator app (MFA)">
            <MfaPanel enabled={session.mfaEnabled} required={mfaRequiredForRole(session.role)} />
          </Card>
        </>
      )}

      <Card title="Active sessions">
        <SessionsPanel sessions={sessions} />
      </Card>
    </div>
  );
}
