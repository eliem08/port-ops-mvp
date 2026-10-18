// PortTwin simulation — run list, new-run form, compare picker.
// Every simulation surface carries the uncalibrated notice + synthetic tag.

import Link from "next/link";
import { getDb } from "@/lib/db/client";
import {
  listSimulationRuns,
  DEMO_SIMULATION_SCENARIOS,
} from "@/lib/simulation";
import {
  appointmentVolumeSummary,
  proposeSimulationBridge,
} from "@/lib/demo-workflow";
import {
  Card,
  EmptyState,
  SyntheticTag,
  UncalibratedBanner,
  formatDateTime,
} from "@/components/ui";
import { NewSimulationForm, ComparePicker } from "./sim-form";
import { AppointmentBridgeForm } from "./bridge-form";

export default async function SimulatePage() {
  const runs = listSimulationRuns(getDb());

  // Explicit appointment→simulation bridge: computed live from the TAS
  // appointments table. Nothing here is automatic — the bridge form shows
  // the derivation and lets the operator edit every assumption.
  const bridgeSummary = appointmentVolumeSummary(
    getDb(),
    new Date().toISOString().slice(0, 10)
  );
  const bridgeProposal = proposeSimulationBridge(bridgeSummary);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">PortTwin simulation</h1>
          <p className="mt-1 text-sm text-muted">
            What-if scenarios on the port twin. Illustrative only — never
            predictions of real port performance.
          </p>
        </div>
        <SyntheticTag />
      </div>

      <UncalibratedBanner />

      <Card title="New simulation">
        <NewSimulationForm scenarios={DEMO_SIMULATION_SCENARIOS} />
      </Card>

      <Card title="Explicit bridge: today's appointments → simulation">
        <AppointmentBridgeForm
          summary={bridgeSummary}
          proposal={bridgeProposal}
          scenarios={DEMO_SIMULATION_SCENARIOS}
        />
      </Card>

      <Card
        title="Past runs"
        action={
          <span className="text-xs text-muted">
            {runs.length} run{runs.length === 1 ? "" : "s"}
          </span>
        }
      >
        {runs.length === 0 ? (
          <EmptyState
            title="No simulation runs yet"
            hint="Run your first scenario above — it takes a few seconds."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                  <th scope="col" className="py-2 pr-4 font-medium">Run name</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Scenario</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Seed</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Replications</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Created</th>
                  <th scope="col" className="py-2 font-medium">
                    <span className="sr-only">Detail</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-0 hover:bg-paper">
                    <td className="py-2 pr-4 font-medium text-ink">{r.scenarioName}</td>
                    <td className="py-2 pr-4 font-mono text-muted">{r.scenarioId}</td>
                    <td className="py-2 pr-4 font-mono text-muted">{r.seed}</td>
                    <td className="py-2 pr-4 font-mono text-muted">{r.replications}</td>
                    <td className="py-2 pr-4 text-muted">{formatDateTime(r.createdAt)}</td>
                    <td className="py-2">
                      <Link
                        href={`/simulate/runs/${r.id}`}
                        className="font-medium text-accent hover:underline"
                      >
                        Detail
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {runs.length >= 2 && (
        <Card title="Compare two runs">
          <ComparePicker runs={runs} />
        </Card>
      )}
    </div>
  );
}
