// Demo login — lists the five known demo identities from the DB.
// Big DEMO warning: this is a session-cookie demo, not production auth.

import { listDemoUsers } from "@/lib/demo-users";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  const users = listDemoUsers();

  return (
    <div className="mx-auto max-w-md py-8">
      <div
        role="alert"
        className="mb-6 rounded border-2 border-danger bg-danger/10 px-4 py-4"
      >
        <p className="text-base font-bold text-danger">DEMO — SYNTHETIC DATA</p>
        <p className="mt-1 text-sm text-ink">
          Pick a demo identity to sign in. There are no passwords: this is a
          demo session cookie, not a production identity provider. Nothing here
          is real port, ANP, or terminal data.
        </p>
      </div>

      <h1 className="mb-4 text-xl font-bold text-ink">Demo sign-in</h1>
      {users.length === 0 ? (
        <p className="rounded border border-line bg-white px-4 py-6 text-center text-sm text-muted">
          No demo users found. Run <code className="font-mono">npm run db:seed</code>.
        </p>
      ) : (
        <LoginForm users={users} />
      )}
    </div>
  );
}
