"use client";

// Simulated gate scan form. All input is operator-typed fiction — the scan
// is ALWAYS synthetic; there is no real camera or OCR in this demo.

import { useState } from "react";
import { submitScanAction, type ScanResult } from "@/lib/actions";
import { OutcomeBadge } from "@/components/ui";
import type { AppointmentDTO } from "@/lib/appointments";

export function ScanForm({ appointments }: { appointments: AppointmentDTO[] }) {
  const [result, setResult] = useState<ScanResult | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(formData: FormData) {
    setPending(true);
    setResult(null);
    const r = await submitScanAction(formData);
    setPending(false);
    setResult(r);
  }

  return (
    <div className="space-y-4">
      <div
        role="alert"
        className="rounded border-2 border-warn bg-warn/10 px-4 py-3"
      >
        <p className="text-sm font-bold text-warn">
          SIMULATED SCAN — not a real camera
        </p>
        <p className="mt-1 text-sm text-ink">
          Everything below is operator-typed demo input. The verification runs
          the real GateWatch logic, but against synthetic reads only.
        </p>
      </div>

      <form action={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="appointmentId" className="mb-1 block text-sm font-medium text-ink">
            Appointment <span className="text-danger">*</span>
          </label>
          <select
            id="appointmentId"
            name="appointmentId"
            required
            className="w-full rounded border border-line bg-white px-3 py-2 text-sm text-ink"
          >
            {appointments.map((a) => (
              <option key={a.id} value={a.id}>
                {a.truckPlate} — {a.containerNo ?? "no container"} — {a.status}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="plateRead" className="mb-1 block text-sm font-medium text-ink">
              Plate read (simulated)
            </label>
            <input
              id="plateRead"
              name="plateRead"
              type="text"
              maxLength={20}
              placeholder="e.g. CAS-4821-A"
              className="w-full rounded border border-line px-3 py-2 text-sm text-ink"
            />
          </div>
          <div>
            <label htmlFor="containerRead" className="mb-1 block text-sm font-medium text-ink">
              Container read (simulated)
            </label>
            <input
              id="containerRead"
              name="containerRead"
              type="text"
              maxLength={11}
              placeholder="e.g. TCLU4829103"
              className="w-full rounded border border-line px-3 py-2 text-sm text-ink"
            />
          </div>
        </div>

        <div>
          <label htmlFor="confidence" className="mb-1 block text-sm font-medium text-ink">
            OCR confidence (0–100)
          </label>
          <input
            id="confidence"
            name="confidence"
            type="number"
            min={0}
            max={100}
            step="any"
            placeholder="e.g. 92 (leave blank to simulate a failed read)"
            aria-describedby="confidence-hint"
            className="w-full rounded border border-line px-3 py-2 text-sm text-ink"
          />
          <p id="confidence-hint" className="mt-1 text-xs text-muted">
            Below 70 routes to human review. Blank, non-numeric, or out-of-range
            confidence can never auto-accept.
          </p>
        </div>

        <button
          type="submit"
          disabled={pending}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Verifying…" : "Submit simulated scan"}
        </button>
      </form>

      {result && (
        <div
          role={result.ok ? "status" : "alert"}
          className={`rounded border px-4 py-4 ${
            result.ok ? "border-line bg-paper" : "border-danger/40 bg-danger/10"
          }`}
        >
          {!result.ok ? (
            <p className="text-sm text-danger">{result.message}</p>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                {result.outcome && <OutcomeBadge outcome={result.outcome} />}
                <p className="text-sm text-muted">{result.message}</p>
              </div>
              {result.reason && <p className="text-sm text-ink">{result.reason}</p>}
              {result.eventId && (
                <p className="font-mono text-xs text-muted">
                  Verification event: {result.eventId}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
