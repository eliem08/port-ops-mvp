"use client";

// Status transition buttons — only the transitions legal from the current
// status are rendered. The server action re-checks legality too.

import { useState } from "react";
import { STATUS_TRANSITIONS, type AppointmentStatus as StatusT } from "@/contracts";
import { transitionAppointmentAction } from "@/lib/actions";

export function TransitionButtons({
  appointmentId,
  current,
}: {
  appointmentId: string;
  current: StatusT;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const legal = STATUS_TRANSITIONS[current] ?? [];
  if (legal.length === 0) {
    return (
      <p className="text-sm text-muted">
        Terminal status — no further transitions are legal.
      </p>
    );
  }

  async function transition(to: StatusT) {
    setBusy(to);
    setMessage(null);
    setError(null);
    const result = await transitionAppointmentAction(appointmentId, to);
    setBusy(null);
    if (result.ok) {
      setMessage(result.message);
      window.location.reload(); // pick up the new status + timeline
    } else {
      setError(result.message);
    }
  }

  return (
    <div className="space-y-3">
      {message && (
        <p role="status" className="rounded border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {legal.map((to) => (
          <button
            key={to}
            type="button"
            onClick={() => transition(to)}
            disabled={busy !== null}
            className="rounded border border-accent/40 bg-accent/10 px-3 py-1.5 text-sm font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
            aria-label={`Change status to ${to}`}
          >
            {busy === to ? "Updating…" : `Mark ${to}`}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">
        Only legal transitions from <code className="font-mono">{current}</code> are
        shown (per the TAS contract state machine).
      </p>
    </div>
  );
}
