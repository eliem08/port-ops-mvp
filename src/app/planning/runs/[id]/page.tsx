// Plan run detail — full solver result. Server component.

import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { getPlanRun, SOLVER_LABELS } from "@/lib/planning";
import {
  Card,
  EmptyState,
  SyntheticTag,
  formatDateTime,
} from "@/components/ui";
import { OptimalityBanner } from "../../optimality-banner";

export default async function PlanRunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const run = getPlanRun(getDb(), id);
  if (!run) notFound();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            href="/planning"
            className="text-sm font-medium text-accent hover:underline"
          >
            ← All plan runs
          </Link>
          <h1 className="mt-1 text-xl font-bold text-ink">{run.name}</h1>
          <p className="mt-1 text-sm text-muted">
            {run.vesselCount} vessels · {run.assignments.length} assigned ·{" "}
            {run.unassigned.length} unassigned · created{" "}
            {formatDateTime(run.createdAt)} UTC
          </p>
        </div>
        <SyntheticTag />
      </div>

      <OptimalityBanner run={run} />

      {/* KPIs */}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Total waiting", `${run.totalWaitingHours.toFixed(1)} h`],
          ["Makespan", `${run.makespanHours.toFixed(1)} h`],
          ["Assigned", `${run.assignments.length}/${run.vesselCount}`],
          [
            "Solver",
            run.solverUsed === run.solverRequested
              ? SOLVER_LABELS[run.solverUsed]
              : `${SOLVER_LABELS[run.solverUsed]} (requested ${SOLVER_LABELS[run.solverRequested]})`,
          ],
        ].map(([label, value]) => (
          <div key={label} className="rounded border border-line bg-white px-3 py-3">
            <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
            <dd className="mt-1 text-lg font-bold text-ink">{value}</dd>
          </div>
        ))}
      </dl>

      <Card title="Berth assignments">
        {run.assignments.length === 0 ? (
          <EmptyState title="No vessels were assigned to any berth." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                  <th scope="col" className="py-2 pr-4 font-medium">Vessel</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Berth</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Start (UTC)</th>
                  <th scope="col" className="py-2 pr-4 font-medium">End (UTC)</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Waiting (h)</th>
                </tr>
              </thead>
              <tbody>
                {run.assignments.map((a) => (
                  <tr key={a.vesselId} className="border-b border-line last:border-0 hover:bg-paper">
                    <td className="py-2 pr-4 font-medium text-ink">{a.vesselName}</td>
                    <td className="py-2 pr-4 text-ink">{a.berthName}</td>
                    <td className="py-2 pr-4 text-muted">{formatDateTime(a.startAt)}</td>
                    <td className="py-2 pr-4 text-muted">{formatDateTime(a.endAt)}</td>
                    <td className="py-2 pr-4 text-muted">{a.waitingHours.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Per-berth utilization">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                <th scope="col" className="py-2 pr-4 font-medium">Berth</th>
                <th scope="col" className="py-2 pr-4 font-medium">Busy (h)</th>
                <th scope="col" className="py-2 pr-4 font-medium">Utilization</th>
                <th scope="col" className="py-2 pr-4 font-medium">Assignments</th>
              </tr>
            </thead>
            <tbody>
              {run.berthUtilization.map((u) => (
                <tr key={u.berthId} className="border-b border-line last:border-0 hover:bg-paper">
                  <td className="py-2 pr-4 font-medium text-ink">{u.berthName}</td>
                  <td className="py-2 pr-4 text-muted">{u.busyHours.toFixed(1)}</td>
                  <td className="py-2 pr-4">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-32 overflow-hidden rounded bg-paper">
                        <div
                          className="h-full rounded bg-accent"
                          style={{ width: `${Math.min(100, u.utilizationPct)}%` }}
                        />
                      </div>
                      <span className="text-muted">{u.utilizationPct.toFixed(1)}%</span>
                    </div>
                  </td>
                  <td className="py-2 pr-4 text-muted">{u.assignments}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">
          Utilization is the berth&apos;s busy hours as a share of the plan makespan.
        </p>
      </Card>

      <Card title={`Unassigned vessels (${run.unassigned.length})`}>
        {run.unassigned.length === 0 ? (
          <p className="text-sm text-muted">All vessels were assigned to a berth.</p>
        ) : (
          <ul className="space-y-2">
            {run.unassigned.map((u) => (
              <li
                key={u.vesselId}
                className="rounded border border-warn/30 bg-warn/10 px-3 py-2"
              >
                <p className="text-sm font-medium text-ink">{u.vesselName}</p>
                <p className="mt-0.5 text-xs text-muted">{u.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Assumptions">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          {run.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </Card>

      <Card title="Limitations">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li>
            The exact solver is limited to 8 vessels; larger instances are
            solved with a heuristic and are never labelled optimal.
          </li>
          <li>
            ALNS is not offered in this demo — its runtime is superlinear and
            unsuitable for interactive use.
          </li>
          <li>
            Plans are built from synthetic ETA/ETD windows with fixed
            handling assumptions; they do not model tides, crane breakdowns,
            or real terminal constraints.
          </li>
        </ul>
      </Card>
    </div>
  );
}
