// Compare two simulation runs side by side, with per-KPI deltas (B − A).

import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import {
  compareSimulationRuns,
  SimulationNotFoundError,
  type KpiDelta,
} from "@/lib/simulation";
import { EntityId } from "@/contracts";
import {
  Card,
  SyntheticTag,
  UncalibratedBanner,
  formatDateTime,
} from "@/components/ui";

function formatValue(v: number | string): string {
  if (typeof v !== "number") return v;
  return Number.isInteger(v) ? v.toLocaleString("en-US") : v.toFixed(1);
}

function formatDelta(d: KpiDelta): string {
  if (d.delta === null) return "—";
  const s = d.delta > 0 ? "+" : "";
  const v = d.delta;
  return `${s}${Number.isInteger(v) ? v.toLocaleString("en-US") : v.toFixed(1)}`;
}

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ a?: string; b?: string }>;
}) {
  const sp = await searchParams;
  const a = EntityId.safeParse(sp.a);
  const b = EntityId.safeParse(sp.b);
  if (!a.success || !b.success) notFound();

  let cmp;
  try {
    cmp = compareSimulationRuns(getDb(), a.data, b.data);
  } catch (err) {
    if (err instanceof SimulationNotFoundError) notFound();
    throw err;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            href="/simulate"
            className="text-sm font-medium text-accent hover:underline"
          >
            ← All simulations
          </Link>
          <h1 className="mt-1 text-xl font-bold text-ink">
            Compare simulation runs
          </h1>
          <p className="mt-1 text-sm text-muted">
            Delta = B − A. Illustrative model outputs, not measured performance.
          </p>
        </div>
        <SyntheticTag />
      </div>

      <UncalibratedBanner />

      <div className="grid gap-4 md:grid-cols-2">
        {[
          { tag: "A", run: cmp.a },
          { tag: "B", run: cmp.b },
        ].map(({ tag, run }) => (
          <Card
            key={tag}
            title={`Run ${tag}: ${run.scenarioName}`}
            action={
              <Link
                href={`/simulate/runs/${run.id}`}
                className="text-sm font-medium text-accent hover:underline"
              >
                Detail
              </Link>
            }
          >
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">Scenario</dt>
                <dd className="font-mono text-ink">{run.scenarioId}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Seed</dt>
                <dd className="font-mono text-ink">{run.seed}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Replications</dt>
                <dd className="font-mono text-ink">{run.replications}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Created</dt>
                <dd className="text-ink">{formatDateTime(run.createdAt)}</dd>
              </div>
            </dl>
          </Card>
        ))}
      </div>

      <Card title="Side-by-side KPIs (Δ = B − A)">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                <th scope="col" className="py-2 pr-4 font-medium">KPI</th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  A · {cmp.a.scenarioName}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  B · {cmp.b.scenarioName}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">Δ (B − A)</th>
                <th scope="col" className="py-2 font-medium">Unit</th>
              </tr>
            </thead>
            <tbody>
              {cmp.deltas.map((d) => (
                <tr key={d.key} className="border-b border-line last:border-0 hover:bg-paper">
                  <td className="py-2 pr-4 text-ink">{d.label}</td>
                  <td className="py-2 pr-4 font-mono text-muted">{formatValue(d.a)}</td>
                  <td className="py-2 pr-4 font-mono text-muted">{formatValue(d.b)}</td>
                  <td className="py-2 pr-4 font-mono font-medium text-ink">
                    {formatDelta(d)}
                  </td>
                  <td className="py-2 text-muted">{d.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted">
          For waits and queues, a negative delta means B is better than A; for
          throughput, a positive delta means B is better. All figures simulated.
        </p>
      </Card>
    </div>
  );
}
