"use client";

// Client forms for the account page. All writes go through /api/account/*.

import { useState } from "react";
import qrcode from "qrcode-generator";
import { formatDateTime } from "@/components/ui";

const INPUT =
  "mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";
const BUTTON =
  "rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50";
const SECONDARY =
  "rounded border border-line bg-white px-3 py-1.5 text-sm text-ink hover:bg-paper disabled:opacity-50";

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

function Message({ kind, text }: { kind: "ok" | "error"; text: string }) {
  return (
    <p
      role={kind === "error" ? "alert" : "status"}
      className={`rounded px-3 py-2 text-sm ${kind === "error" ? "bg-danger/10 text-danger" : "bg-accent/10 text-accent"}`}
    >
      {text}
    </p>
  );
}

export function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) return setMsg({ kind: "error", text: "The new passwords do not match." });
    setBusy(true);
    setMsg(null);
    try {
      await call("/api/account/password", "POST", { currentPassword: current, newPassword: next });
      setMsg({ kind: "ok", text: "Password changed. Other devices have been signed out." });
      setCurrent("");
      setNext("");
      setConfirm("");
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:max-w-sm">
      {msg && <Message {...msg} />}
      <label className="text-sm font-medium text-ink">
        Current password
        <input className={INPUT} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </label>
      <label className="text-sm font-medium text-ink">
        New password
        <input className={INPUT} type="password" autoComplete="new-password" minLength={12} value={next} onChange={(e) => setNext(e.target.value)} required />
        <span className="mt-1 block text-xs font-normal text-muted">At least 12 characters; avoid common or repetitive passwords.</span>
      </label>
      <label className="text-sm font-medium text-ink">
        Confirm new password
        <input className={INPUT} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </label>
      <div>
        <button type="submit" className={BUTTON} disabled={busy}>
          {busy ? "Saving…" : "Change password"}
        </button>
      </div>
    </form>
  );
}

function QrCode({ text }: { text: string }) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return (
    <div
      className="inline-block rounded border border-line bg-white p-2"
      aria-label="QR code for your authenticator app"
      // qrcode-generator emits a self-contained SVG built only from our otpauth URL.
      dangerouslySetInnerHTML={{ __html: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) }}
      style={{ width: 200, height: 200 }}
    />
  );
}

export function MfaPanel({ enabled, required }: { enabled: boolean; required: boolean }) {
  const [enrollment, setEnrollment] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (enabled) {
    return (
      <div className="space-y-3">
        {msg && <Message {...msg} />}
        <p className="text-sm text-ink">
          <span className="font-medium text-accent">Enabled.</span> Sign-in asks for a code from your authenticator app.
        </p>
        {required ? (
          <p className="text-xs text-muted">MFA is mandatory for your role and cannot be turned off.</p>
        ) : (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await call("/api/account/mfa", "POST", { action: "disable", password });
                window.location.reload();
              });
            }}
          >
            <label className="text-sm font-medium text-ink">
              Password
              <input className={INPUT} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            <button type="submit" className={SECONDARY} disabled={busy}>
              Turn off MFA
            </button>
          </form>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {msg && <Message {...msg} />}
      {!enrollment ? (
        <>
          <p className="text-sm text-ink">
            Protect your account with a time-based code from an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password…).
          </p>
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => run(async () => setEnrollment(await call("/api/account/mfa", "POST", { action: "begin" })))}
          >
            Set up authenticator app
          </button>
        </>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await call("/api/account/mfa", "POST", { action: "confirm", code: code.trim() });
              window.location.href = "/account";
            });
          }}
        >
          <p className="text-sm text-ink">1. Scan this QR code with your authenticator app.</p>
          <QrCode text={enrollment.otpauthUrl} />
          <p className="text-xs text-muted">
            Can&apos;t scan? Enter this key manually: <code className="select-all break-all font-mono text-ink">{enrollment.secret}</code>
          </p>
          <label className="block text-sm font-medium text-ink sm:max-w-xs">
            2. Enter the 6-digit code it shows
            <input className={`${INPUT} font-mono tracking-widest`} inputMode="numeric" autoComplete="one-time-code" maxLength={10} value={code} onChange={(e) => setCode(e.target.value)} required />
          </label>
          <button type="submit" className={BUTTON} disabled={busy}>
            {busy ? "Verifying…" : "Enable MFA"}
          </button>
        </form>
      )}
    </div>
  );
}

interface SessionView {
  id: string;
  authMethod: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}

export function SessionsPanel({ sessions }: { sessions: SessionView[] }) {
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const others = sessions.filter((s) => !s.current).length;

  async function signOutOthers() {
    setBusy(true);
    try {
      const data = await call("/api/account/sessions", "DELETE");
      setMsg({ kind: "ok", text: `Signed out ${data.revoked} other session(s).` });
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {msg && <Message {...msg} />}
      <ul className="divide-y divide-line text-sm">
        {sessions.map((s) => (
          <li key={s.id} className="flex flex-wrap justify-between gap-2 py-2">
            <span className="text-ink">
              {s.userAgent ? s.userAgent.slice(0, 80) : "Unknown device"}
              {s.current && <span className="ml-2 rounded bg-accent/10 px-1.5 py-0.5 text-xs text-accent">this device</span>}
            </span>
            <span className="text-xs text-muted">
              {s.authMethod} · {s.ip ?? "unknown IP"} · since {formatDateTime(s.createdAt)}
            </span>
          </li>
        ))}
      </ul>
      {others > 0 && (
        <button type="button" className={SECONDARY} disabled={busy} onClick={signOutOthers}>
          Sign out other sessions ({others})
        </button>
      )}
    </div>
  );
}
