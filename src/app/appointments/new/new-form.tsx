"use client";

// New appointment form. Calls the createAppointmentAction server action.
// Zod validation errors come back as field errors and are shown inline.

import { useActionState } from "react";
import Link from "next/link";
import { createAppointmentAction, type ActionResult } from "@/lib/actions";

const INITIAL: ActionResult = { ok: true, message: "" };

function Field({
  label,
  name,
  type = "text",
  required = false,
  hint,
  error,
  maxLength,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  hint?: string;
  error?: string;
  maxLength?: number;
}) {
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-sm font-medium text-ink">
        {label} {required && <span className="text-danger">*</span>}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        required={required}
        maxLength={maxLength}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${name}-error` : hint ? `${name}-hint` : undefined}
        className={`w-full rounded border px-3 py-2 text-sm text-ink ${
          error ? "border-danger" : "border-line"
        }`}
      />
      {error ? (
        <p id={`${name}-error`} role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${name}-hint`} className="mt-1 text-xs text-muted">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

export function NewAppointmentForm() {
  const [state, formAction, pending] = useActionState(createAppointmentAction, INITIAL);
  const fe = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="space-y-4" noValidate={false}>
      {!state.ok && (
        <div
          role="alert"
          className="rounded border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
        >
          {state.message}
        </div>
      )}

      <Field
        label="Truck plate"
        name="truckPlate"
        required
        maxLength={20}
        hint="Plate as read at the gate, e.g. CAS-1234-A."
        error={fe.truckPlate}
      />
      <Field
        label="Container number"
        name="containerNo"
        maxLength={11}
        hint="Optional. ISO 6346 format, e.g. TCLU4829103."
        error={fe.containerNo}
      />
      <Field
        label="Driver name"
        name="driverName"
        maxLength={100}
        hint="Optional. Synthetic demo — do not enter a real person's name."
        error={fe.driverName}
      />
      <Field
        label="Scheduled time"
        name="scheduledAt"
        type="datetime-local"
        required
        hint="Slot start, stored as UTC."
        error={fe.scheduledAt}
      />

      <p className="text-xs text-muted">
        The idempotency key is generated automatically. New appointments start in
        status <code className="font-mono">requested</code>.
      </p>

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create appointment"}
        </button>
        <Link
          href="/appointments"
          className="rounded border border-line bg-white px-4 py-2 text-sm text-ink hover:bg-paper"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
