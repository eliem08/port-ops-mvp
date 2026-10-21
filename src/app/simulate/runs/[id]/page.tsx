// Simulation run detail — KPI cards with provenance badges, assumptions,
// uncalibrated banner, reproducibility note (seed + input hash).

import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { getSimulationRun } from "@/lib/simulation";
import { Card, UncalibratedBanner, ProvenanceBadge, formatDateTime } from "@/components/ui";
import { SyntheticTag } from "@/components/synthetic-tag";

function formatValue(v: number | string): string {
  if (typeof v !== "number") return v;
  return Number.isInteger(v) ? v.toLocaleString("en-US") : v.toFixed(1);
}

export default async function SimulationRunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const run = getSimulationRun(getDb(), id);
  if (!run) notFound();

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
          <h1 className="mt-1 text-xl font-bold text-ink">{run.scenarioName}</h1>
          <p className="mt-1 text-sm text-muted">
            Scenario <span className="font-mono">{run.scenarioId}</span> · seed{" "}
            {run.seed} · {run.replications} replications ·{" "}
            {formatDateTime(run.createdAt)}
          </p>
        </div>
        <SyntheticTag />
      </div>

      <UncalibratedBanner />

      <Card
        title="Key performance indicators"
        action={<ProvenanceBadge provenance="simulated" />}
      >
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {run.kpis.map((k) => (
            <div key={k.key} className="rounded border border-line bg-white px-3 py-3">
              <dt className="text-xs text-muted">{k.label}</dt>
              <dd className="mt-1 text-2xl font-bold text-ink">
                {formatValue(k.value)}
                <span className="ml-1 text-sm font-normal text-muted">{k.unit}</span>
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-muted">
          Figures are model outputs for a fixed seed — illustrative, not measured
          port performance.
        </p>
      </Card>

      <Card
        title="Scenario parameters"
        action={<ProvenanceBadge provenance="assumed" />}
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                <th scope="col" className="py-2 pr-4 font-medium">Parameter</th>
                <th scope="col" className="py-2 pr-4 font-medium">Value</th>
                <th scope="col" className="py-2 font-medium">Unit</th>
              </tr>
            </thead>
            <tbody>
              {run.parameters.map((p) => (
                <tr key={p.key} className="border-b border-line last:border-0">
                  <td className="py-2 pr-4 text-ink">{p.label}</td>
                  <td className="py-2 pr-4 font-mono text-muted">{formatValue(p.value)}</td>
                  <td className="py-2 text-muted">{p.unit || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Assumptions">
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
          {run.assumptions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      </Card>

      {run.warnings.length > 0 && (
        <Card title="Model warnings">
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
            {run.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Reproducibility">
        <dl className="space-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="w-32 shrink-0 text-muted">Seed</dt>
            <dd className="font-mono text-ink">{run.seed}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-32 shrink-0 text-muted">Input hash</dt>
            <dd className="break-all font-mono text-ink">{run.inputHash}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-muted">
          Same seed + same inputs ⇒ identical results. Re-running this exact
          input returns this run instead of computing again (idempotent).
        </p>
      </Card>
    </div>
  );
}
