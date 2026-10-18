"use client";

// Explicit appointment→simulation bridge form.
//
// Honesty contract of this component:
//  - Appointments NEVER feed the simulator automatically. This form proposes
//    overrides derived from appointment volume on one date and shows every
//    assumption as an EDITABLE line before the run.
//  - Editing an assumption line changes what is stored on the run — nothing
//    is hidden and nothing is automatic.

import { useActionState } from "react";
import {
  createSimulationRunFromAppointmentsAction,
  type ActionResult,
} from "@/lib/actions";
import type { DemoSimulationScenario } from "@/lib/simulation";
import type {
  AppointmentVolumeSummary,
  SimulationBridgeProposal,
} from "@/lib/demo-workflow";

const INITIAL: ActionResult = { ok: true, message: "" };

const INPUT_CLASS =
  "w-full rounded border border-line px-3 py-2 text-sm text-ink";
const ERROR_CLASS = "border-danger";

export function AppointmentBridgeForm({
  summary,
  proposal,
  scenarios,
}: {
  summary: AppointmentVolumeSummary;
  proposal: SimulationBridgeProposal;
  scenarios: DemoSimulationScenario[];
}) {
  const [state, formAction, pending] = useActionState(
    createSimulationRunFromAppointmentsAction,
    INITIAL
  );
  const fe = state.fieldErrors ?? {};

  return (
    <div className="space-y-4">
      <div className="rounded border border-line bg-paper px-4 py-3 text-sm text-ink">
        <p className="font-medium">Explicit bridge — not automatic</p>
        <p className="mt-1 text-muted">
          For <span className="font-mono">{summary.date}</span> (UTC) the demo
          database holds <strong>{summary.total}</strong> appointment
          {summary.total === 1 ? "" : "s"},{" "}
          <strong>{summary.booked}</strong> of which are in a booked status
          (requested / confirmed / checked-in / completed). The form below
          proposes PortTwin overrides from that volume.{" "}
          <strong>Edit anything before running</strong> — the assumption lines
          are stored verbatim on the run and shown on its detail page.
        </p>
        <p className="mt-2 text-xs text-muted">
          Excluded: {summary.byStatus.cancelled} cancelled ·{" "}
          {summary.byStatus["no-show"]} no-show (contribute 0 trucks).
        </p>
      </div>

      <form action={formAction} className="space-y-4">
        <input type="hidden" name="bridgeDate" value={summary.date} />
        <input
          type="hidden"
          name="assumptionCount"
          value={proposal.assumptions.length}
        />

        {!state.ok && (
          <div
            role="alert"
            className="rounded border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
          >
            {state.message}
          </div>
        )}

        <div>
          <label
            htmlFor="bridge-scenarioName"
            className="mb-1 block text-sm font-medium text-ink"
          >
            Run name <span className="text-danger">*</span>
          </label>
          <input
            id="bridge-scenarioName"
            name="scenarioName"
            type="text"
            required
            maxLength={80}
            defaultValue={proposal.scenarioName}
            aria-invalid={Boolean(fe.scenarioName)}
            className={`${INPUT_CLASS} ${fe.scenarioName ? ERROR_CLASS : ""}`}
          />
          {fe.scenarioName && (
            <p role="alert" className="mt-1 text-xs text-danger">
              {fe.scenarioName}
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor="bridge-scenarioId"
            className="mb-1 block text-sm font-medium text-ink"
          >
            Scenario <span className="text-danger">*</span>
          </label>
          <select
            id="bridge-scenarioId"
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
          {fe.scenarioId && (
            <p role="alert" className="mt-1 text-xs text-danger">
              {fe.scenarioId}
            </p>
          )}
          <p className="mt-1 text-xs text-muted">
            Every preset parameter except the two overrides below is used
            unchanged.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="bridge-trucksPerDay"
              className="mb-1 block text-sm font-medium text-ink"
            >
              Truck demand (/day) <span className="text-danger">*</span>
            </label>
            <input
              id="bridge-trucksPerDay"
              name="trucksPerDay"
              type="number"
              required
              defaultValue={String(proposal.trucksPerDay)}
              aria-invalid={Boolean(fe.trucksPerDay)}
              className={`${INPUT_CLASS} ${fe.trucksPerDay ? ERROR_CLASS : ""}`}
            />
            <p className="mt-1 text-xs text-muted">
              Derived: {summary.booked} booked appointment
              {summary.booked === 1 ? "" : "s"} on {summary.date}. Edit freely.
            </p>
            {fe.trucksPerDay && (
              <p role="alert" className="mt-1 text-xs text-danger">
                {fe.trucksPerDay}
              </p>
            )}
          </div>
          <div>
            <label
              htmlFor="bridge-horizonHours"
              className="mb-1 block text-sm font-medium text-ink"
            >
              Horizon (hours)
            </label>
            <input
              id="bridge-horizonHours"
              name="horizonHours"
              type="number"
              defaultValue={String(proposal.horizonHours)}
              aria-invalid={Boolean(fe.horizonHours)}
              className={`${INPUT_CLASS} ${fe.horizonHours ? ERROR_CLASS : ""}`}
            />
            <p className="mt-1 text-xs text-muted">
              Derived: one operating day. Edit freely.
            </p>
            {fe.horizonHours && (
              <p role="alert" className="mt-1 text-xs text-danger">
                {fe.horizonHours}
              </p>
            )}
          </div>
        </div>

        <fieldset className="rounded border border-line px-3 py-3">
          <legend className="px-1 text-sm font-medium text-ink">
            Assumptions{" "}
            <span className="font-normal text-muted">
              (editable — stored verbatim on the run)
            </span>
          </legend>
          <div className="space-y-3">
            {proposal.assumptions.map((a, i) => (
              <div key={i}>
                <label
                  htmlFor={`bridge-assumption-${i}`}
                  className="mb-1 block text-xs font-medium text-muted"
                >
                  Assumption {i + 1}
                </label>
                <textarea
                  id={`bridge-assumption-${i}`}
                  name={`assumption_${i}`}
                  rows={2}
                  maxLength={500}
                  defaultValue={a}
                  className={`${INPUT_CLASS} font-mono text-xs`}
                />
              </div>
            ))}
          </div>
        </fieldset>

        <p className="text-xs text-muted">
          Requires the planner role. After the run, compare it against a
          baseline run below to see the delta on identical engine settings.
        </p>

        <button
          type="submit"
          disabled={pending}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Running simulation…" : "Run simulation from this bridge"}
        </button>
      </form>
    </div>
  );
}
