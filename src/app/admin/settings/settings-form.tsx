"use client";

import { useState } from "react";
import type { Settings } from "@/lib/settings";

export function SettingsForm({ initial }: { initial: Settings }) {
  const [autoAccept, setAutoAccept] = useState(initial["gate.autoAcceptEnabled"]);
  const [threshold, setThreshold] = useState(initial["gate.reviewThreshold"]);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ "gate.autoAcceptEnabled": autoAccept, "gate.reviewThreshold": threshold }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message ?? `Save failed (${res.status})`);
      setMsg({ kind: "ok", text: "Policy saved." });
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-5">
      {msg && (
        <p role={msg.kind === "error" ? "alert" : "status"} className={`rounded px-3 py-2 text-sm ${msg.kind === "error" ? "bg-danger/10 text-danger" : "bg-accent/10 text-accent"}`}>
          {msg.text}
        </p>
      )}
      <label className="flex items-start gap-3">
        <input type="checkbox" className="mt-1" checked={autoAccept} onChange={(e) => setAutoAccept(e.target.checked)} />
        <span>
          <span className="block text-sm font-medium text-ink">Allow automatic acceptance at the gate</span>
          <span className="block text-xs text-muted">
            When off, every scan — even a perfect match — is routed to a supervisor for confirmation. Recommended for
            supervised pilots and the first weeks on real data.
          </span>
        </span>
      </label>
      <label className="block">
        <span className="block text-sm font-medium text-ink">Minimum OCR confidence for automatic acceptance: {threshold}</span>
        <input
          type="range"
          min={70}
          max={100}
          step={1}
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          className="mt-2 w-full sm:max-w-sm"
          disabled={!autoAccept}
        />
        <span className="block text-xs text-muted">
          Scans below this confidence go to human review. The floor is 70 — OCR below that never authorizes on its own.
        </span>
      </label>
      <button type="submit" disabled={busy} className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
        {busy ? "Saving…" : "Save policy"}
      </button>
    </form>
  );
}
