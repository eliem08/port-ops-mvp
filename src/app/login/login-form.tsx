"use client";

// Email/password sign-in with an optional second step for authenticator codes.

import { useState } from "react";

const INPUT =
  "mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";

export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function post(url: string, body: unknown) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error?.message ?? `Sign-in failed (${res.status})`);
    return data;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (challenge) {
        await post("/api/auth/mfa", { challenge, code: code.trim() });
      } else {
        const data = await post("/api/auth/login", { email, password });
        if (data?.mfaRequired) {
          setChallenge(data.challenge);
          setBusy(false);
          return;
        }
      }
      window.location.href = next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
      if (challenge && err instanceof Error && /expired/i.test(err.message)) {
        setChallenge(null);
        setCode("");
      }
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error && (
        <div role="alert" className="rounded border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}
      {challenge ? (
        <label className="block text-sm font-medium text-ink">
          Authentication code
          <input
            className={`${INPUT} font-mono tracking-widest`}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={10}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
          <span className="mt-1 block text-xs font-normal text-muted">
            Enter the 6-digit code from your authenticator app.
          </span>
        </label>
      ) : (
        <>
          <label className="block text-sm font-medium text-ink">
            Email
            <input
              className={INPUT}
              type="email"
              autoComplete="username"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label className="block text-sm font-medium text-ink">
            Password
            <input
              className={INPUT}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
        </>
      )}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded bg-accent px-4 py-2.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Signing in…" : challenge ? "Verify" : "Sign in"}
      </button>
    </form>
  );
}
