"use client";

// Administrator user management: create, change role, disable/enable,
// unlock, reset password, reset MFA, force sign-out.

import { useState } from "react";
import type { UserSummary } from "@/lib/accounts";
import { formatDateTime } from "@/components/ui";

const ROLES = ["operations_viewer", "operations_operator", "planner", "supervisor", "administrator"] as const;
const INPUT =
  "mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";
const SMALL =
  "rounded border border-line bg-white px-2 py-1 text-xs text-ink hover:bg-paper disabled:opacity-50";

async function call(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
  return data;
}

function Badge({ tone, children }: { tone: "ok" | "warn" | "danger" | "muted"; children: React.ReactNode }) {
  const cls = {
    ok: "bg-accent/10 text-accent",
    warn: "bg-warn/10 text-warn",
    danger: "bg-danger/10 text-danger",
    muted: "bg-paper text-muted",
  }[tone];
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>{children}</span>;
}

export function UserTable({ users, selfId }: { users: UserSummary[]; selfId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function act(id: string, fn: () => Promise<unknown>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusyId(id);
    setError(null);
    try {
      await fn();
      window.location.reload();
    } catch (err) {
      setError((err as Error).message);
      setBusyId(null);
    }
  }

  const patch = (id: string, body: unknown) => call(`/api/admin/users/${id}`, "PATCH", body);

  return (
    <div className="space-y-3">
      {error && (
        <p role="alert" className="rounded bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-muted">
            <tr>
              <th className="py-2 pr-3">User</th>
              <th className="py-2 pr-3">Role</th>
              <th className="py-2 pr-3">Status</th>
              <th className="py-2 pr-3">Last sign-in</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {users.map((u) => {
              const self = u.id === selfId;
              const busy = busyId === u.id;
              return (
                <tr key={u.id} className="align-top">
                  <td className="py-2 pr-3">
                    <p className="font-medium text-ink">
                      {u.label} {self && <Badge tone="muted">you</Badge>}
                    </p>
                    <p className="font-mono text-xs text-muted">{u.email ?? "—"}</p>
                  </td>
                  <td className="py-2 pr-3">
                    <select
                      aria-label={`Role for ${u.label}`}
                      className="rounded border border-line bg-white px-2 py-1 text-xs"
                      value={u.role}
                      disabled={self || busy}
                      onChange={(e) => act(u.id, () => patch(u.id, { role: e.target.value }))}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="space-x-1 py-2 pr-3">
                    {u.disabled ? <Badge tone="danger">disabled</Badge> : <Badge tone="ok">active</Badge>}
                    {u.locked && <Badge tone="warn">locked</Badge>}
                    {u.mfaEnabled && <Badge tone="ok">MFA</Badge>}
                    {u.sso && <Badge tone="muted">SSO</Badge>}
                    {u.mustChangePassword && <Badge tone="warn">temp password</Badge>}
                  </td>
                  <td className="py-2 pr-3 text-xs text-muted">
                    {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "never"}
                    <br />
                    {u.activeSessions} active session(s)
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap gap-1">
                      {!self && (
                        <button
                          type="button"
                          className={SMALL}
                          disabled={busy}
                          onClick={() =>
                            act(u.id, () => patch(u.id, { disabled: !u.disabled }), u.disabled ? undefined : `Disable ${u.label}? Their sessions end immediately.`)
                          }
                        >
                          {u.disabled ? "Enable" : "Disable"}
                        </button>
                      )}
                      {u.locked && (
                        <button type="button" className={SMALL} disabled={busy} onClick={() => act(u.id, () => patch(u.id, { unlock: true }))}>
                          Unlock
                        </button>
                      )}
                      {!u.sso && (
                        <button
                          type="button"
                          className={SMALL}
                          disabled={busy}
                          onClick={() => {
                            const pw = window.prompt(`Temporary password for ${u.label} (min 12 characters). They must change it at next sign-in.`);
                            if (pw) act(u.id, () => patch(u.id, { resetPassword: pw }));
                          }}
                        >
                          Reset password
                        </button>
                      )}
                      {u.mfaEnabled && (
                        <button
                          type="button"
                          className={SMALL}
                          disabled={busy}
                          onClick={() => act(u.id, () => patch(u.id, { resetMfa: true }), `Remove ${u.label}'s authenticator? They must enroll again.`)}
                        >
                          Reset MFA
                        </button>
                      )}
                      {u.activeSessions > 0 && !self && (
                        <button type="button" className={SMALL} disabled={busy} onClick={() => act(u.id, () => call(`/api/admin/users/${u.id}/sessions`, "DELETE"))}>
                          Sign out
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function CreateUserForm() {
  const [form, setForm] = useState({ email: "", label: "", role: "operations_viewer", password: "" });
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await call("/api/admin/users", "POST", form);
      setMsg({ kind: "ok", text: `Created ${form.email}. Share the temporary password through a secure channel.` });
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      {msg && (
        <p role={msg.kind === "error" ? "alert" : "status"} className={`sm:col-span-2 rounded px-3 py-2 text-sm ${msg.kind === "error" ? "bg-danger/10 text-danger" : "bg-accent/10 text-accent"}`}>
          {msg.text}
        </p>
      )}
      <label className="text-sm font-medium text-ink">
        Email
        <input className={INPUT} type="email" value={form.email} onChange={set("email")} required />
      </label>
      <label className="text-sm font-medium text-ink">
        Display name
        <input className={INPUT} value={form.label} onChange={set("label")} required maxLength={100} />
      </label>
      <label className="text-sm font-medium text-ink">
        Role
        <select className={INPUT} value={form.role} onChange={set("role")}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm font-medium text-ink">
        Temporary password
        <input className={INPUT} type="text" autoComplete="off" value={form.password} onChange={set("password")} required minLength={12} />
      </label>
      <div className="sm:col-span-2">
        <button type="submit" disabled={busy} className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
          {busy ? "Creating…" : "Create account"}
        </button>
      </div>
    </form>
  );
}
