"use client";

// Simulation UI: new-run form (server action) + two-run compare picker.
// Every surface carries the uncalibrated notice via the parent page.

import { useActionState, useState } from "react";
import Link from "next/link";
import { createSimulationRunAction, type ActionResult } from "@/lib/actions";
import type {
  DemoSimulationScenario,
  SimulationRunDTO,
} from "@/lib/simulation";

const INITIAL: ActionResult = { ok: true, message: "" };

const INPUT_CLASS =
  "w-full rounded border border-line px-3 py-2 text-sm text-ink";
const ERROR_CLASS = "border-danger";

function Field({
  label,
  name,
  type = "text",
  required = false,
  hint,
  error,
  defaultValue,
  maxLength,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  hint?: string;
  error?: string;
  defaultValue?: string;
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
        defaultValue={defaultValue}
        maxLength={maxLength}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${name}-error` : hint ? `${name}-hint` : undefined}
        className={`${INPUT_CLASS} ${error ? ERROR_CLASS : ""}`}
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

export function NewSimulationForm({
  scenarios,
}: {
  scenarios: DemoSimulationScenario[];
}) {
  const [state, formAction, pending] = useActionState(
    createSimulationRunAction,
    INITIAL
  );
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
        label="Run name"
        name="scenarioName"
        required
        maxLength={80}
        hint="Your label for this run, e.g. 'Crisis baseline'."
        error={fe.scenarioName}
      />

      <div>
        <label
          htmlFor="scenarioId"
          className="mb-1 block text-sm font-medium text-ink"
        >
          Scenario <span className="text-danger">*</span>
        </label>
        <select
          id="scenarioId"
          name="scenarioId"
          required
          defaultValue={scenarios[0]?.id ?? ""}
          aria-invalid={Boolean(fe.scenarioId)}
          className={`${INPUT_CLASS} ${fe.scenarioId ? ERROR_CLASS : ""}`}
        >
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <div className="mt-2 space-y-1">
          {scenarios.map((s) => (
            <p key={s.id} className="text-xs text-muted">
              <span className="font-medium text-ink">{s.name}:</span>{" "}
              {s.description}
            </p>
          ))}
        </div>
        {fe.scenarioId && (
          <p role="alert" className="mt-1 text-xs text-danger">
            {fe.scenarioId}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Seed"
          name="seed"
          type="number"
          defaultValue="42"
          hint="Fixed seed ⇒ reproducible run."
          error={fe.seed}
        />
        <Field
          label="Replications"
          name="replications"
          type="number"
          defaultValue="100"
          hint="Monte Carlo replications (10–500)."
          error={fe.replications}
        />
      </div>

      <fieldset className="rounded border border-line px-3 py-3">
        <legend className="px-1 text-sm font-medium text-ink">
          Optional parameter overrides{" "}
          <span className="font-normal text-muted">(assumed, not measured)</span>
        </legend>
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Horizon (hours)"
            name="horizonHours"
            type="number"
            hint="Simulated hours. Default 24."
            error={fe.horizonHours}
          />
          <Field
            label="Truck demand (/day)"
            name="trucksPerDay"
            type="number"
            hint="Attempted arrivals per day."
            error={fe.trucksPerDay}
          />
          <Field
            label="Active gates"
            name="numGates"
            type="number"
            hint="Gate lanes serving trucks."
            error={fe.numGates}
          />
          <Field
            label="Mean gate service (min)"
            name="gateServiceMeanMin"
            type="number"
            hint="Customs speed per truck."
            error={fe.gateServiceMeanMin}
          />
        </div>
      </fieldset>

      <p className="text-xs text-muted">
        Runs are synchronous and take a few seconds. Identical inputs return the
        existing run (idempotent) instead of re-running.
      </p>

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Running simulation…" : "Run simulation"}
        </button>
        <Link
          href="/simulate"
          className="rounded border border-line bg-white px-4 py-2 text-sm text-ink hover:bg-paper"
        >
          Reset
        </Link>
      </div>
    </form>
  );
}

function runLabel(r: SimulationRunDTO): string {
  return `${r.scenarioName} — ${r.scenarioId} (seed ${r.seed}, ${r.replications} reps)`;
}

export function ComparePicker({ runs }: { runs: SimulationRunDTO[] }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const ready = a !== "" && b !== "" && a !== b;

  const selectClass = `${INPUT_CLASS} max-w-xs`;

  return (
    <div className="flex flex-wrap items-end gap-4">
      <div>
        <label htmlFor="compare-a" className="mb-1 block text-sm font-medium text-ink">
          Run A
        </label>
        <select
          id="compare-a"
          value={a}
          onChange={(e) => setA(e.target.value)}
          className={selectClass}
        >
          <option value="">Choose a run…</option>
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              {runLabel(r)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="compare-b" className="mb-1 block text-sm font-medium text-ink">
          Run B
        </label>
        <select
          id="compare-b"
          value={b}
          onChange={(e) => setB(e.target.value)}
          className={selectClass}
        >
          <option value="">Choose a run…</option>
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              {runLabel(r)}
            </option>
          ))}
        </select>
      </div>
      {ready ? (
        <Link
          href={`/simulate/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          Compare
        </Link>
      ) : (
        <span className="rounded border border-line bg-paper px-4 py-2 text-sm text-muted">
          Select two different runs
        </span>
      )}
    </div>
  );
}
