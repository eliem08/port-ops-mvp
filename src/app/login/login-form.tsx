"use client";

// Demo identity picker: one click per role, POSTs { userId } to /api/auth/login.

import { useState } from "react";
import type { DemoUserInfo } from "@/lib/demo-users";

export function LoginForm({ users }: { users: DemoUserInfo[] }) {
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function login(userId: string) {
    setBusyId(userId);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message ?? `Login failed (${res.status})`);
      }
      window.location.href = "/";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed.");
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-3">
      {error && (
        <div role="alert" className="rounded border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}
      {users.map((u) => (
        <button
          key={u.id}
          type="button"
          onClick={() => login(u.id)}
          disabled={busyId !== null}
          className="flex w-full items-center justify-between rounded border border-line bg-white px-4 py-3 text-left hover:border-accent disabled:opacity-50"
        >
          <span>
            <span className="block text-sm font-medium text-ink">{u.label}</span>
            <span className="block font-mono text-xs text-muted">{u.id}</span>
          </span>
          <span className="rounded border border-line bg-paper px-2 py-1 text-xs text-slate2">
            {busyId === u.id ? "Signing in…" : u.role}
          </span>
        </button>
      ))}
    </div>
  );
}
