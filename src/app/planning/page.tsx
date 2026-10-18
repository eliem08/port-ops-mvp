// BerthWise planning — list of persisted plan runs + new-plan form.
// Server component; plan runs are read directly via the shared planning lib.

import Link from "next/link";
import { getDb } from "@/lib/db/client";
import {
  listPlanRuns,
  SOLVER_LABELS,
  type BerthPlanDTO,
} from "@/lib/planning";
import {
  Card,
  EmptyState,
  SyntheticTag,
  formatDateTime,
} from "@/components/ui";
import { OptimalityBadge } from "./optimality-banner";
import { PlanForm } from "./plan-form";

function RunRow({ run }: { run: BerthPlanDTO }) {
  return (
    <tr className="border-b border-line last:border-0 hover:bg-paper">
      <td className="py-2 pr-4 text-ink">{run.name}</td>
      <td className="py-2 pr-4 text-muted">{SOLVER_LABELS[run.solverUsed]}</td>
      <td className="py-2 pr-4 text-muted">{run.vesselCount}</td>
      <td className="py-2 pr-4">
        <OptimalityBadge run={run} />
      </td>
      <td className="py-2 pr-4 text-muted">{formatDateTime(run.createdAt)}</td>
      <td className="py-2">
        <Link
          href={`/planning/runs/${run.id}`}
          className="font-medium text-accent hover:underline"
        >
          Detail
        </Link>
      </td>
    </tr>
  );
}

export default async function PlanningPage() {
  const runs = listPlanRuns(getDb());

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">BerthWise planning</h1>
          <p className="mt-1 text-sm text-muted">
            Berth allocation solver runs. All scenarios and results are
            synthetic demo data.
          </p>
        </div>
        <SyntheticTag />
      </div>

      <Card title="New plan run">
        <PlanForm />
      </Card>

      <Card title="Past plan runs">
        {runs.length === 0 ? (
          <EmptyState
            title="No plan runs yet"
            hint="Pick a synthetic demo scenario above and run a solver."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                  <th scope="col" className="py-2 pr-4 font-medium">Run</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Solver used</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Vessels</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Result</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Created (UTC)</th>
                  <th scope="col" className="py-2 font-medium">
                    <span className="sr-only">Detail</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <RunRow key={r.id} run={r} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
