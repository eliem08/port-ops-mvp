"use client";

// New plan form: pick a synthetic demo preset, choose a solver, run it.
// POSTs to /api/planning/runs and navigates to the persisted run.

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  DEMO_PLANNING_SCENARIOS,
  SOLVER_LABELS,
} from "@/lib/planning-data";
import { SolverChoice as SolverChoiceSchema, type SolverChoice } from "@/contracts";

const SOLVERS = SolverChoiceSchema.options;

const inputCls =
  "w-full rounded border border-line px-3 py-2 text-sm text-ink bg-white";
const labelCls = "mb-1 block text-sm font-medium text-ink";

export function PlanForm() {
  const router = useRouter();
  const [presetIdx, setPresetIdx] = useState(0);
  const [solver, setSolver] = useState<SolverChoice>(
    DEMO_PLANNING_SCENARIOS[0].suggestedSolver
  );
  const [scenarioName, setScenarioName] = useState(
    DEMO_PLANNING_SCENARIOS[0].name
  );
  const [seed, setSeed] = useState("42");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preset = DEMO_PLANNING_SCENARIOS[presetIdx];

  function pickPreset(i: number) {
    setPresetIdx(i);
    const p = DEMO_PLANNING_SCENARIOS[i];
    setSolver(p.suggestedSolver);
    setScenarioName(p.name);
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const seedNum = Number.parseInt(seed, 10);
      const res = await fetch("/api/planning/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scenarioName: scenarioName.trim() || preset.name,
          vessels: preset.vessels,
          berths: preset.berths,
          solver,
          seed: Number.isFinite(seedNum) ? seedNum : 42,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg =
          data?.error?.message ??
          `Request failed with status ${res.status}.`;
        throw new Error(msg);
      }
      router.push(`/planning/runs/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Plan run failed.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && (
        <div
          role="alert"
          className="rounded border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
        >
          {error}
        </div>
      )}

      <div>
        <label htmlFor="preset" className={labelCls}>
          Demo scenario preset
        </label>
        <select
          id="preset"
          className={inputCls}
          value={presetIdx}
          onChange={(e) => pickPreset(Number(e.target.value))}
        >
          {DEMO_PLANNING_SCENARIOS.map((p, i) => (
            <option key={p.name} value={i}>
              {p.name}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-muted">
          {preset.description} — {preset.vessels.length} vessels,{" "}
          {preset.berths.length} berths. All values synthetic.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="solver" className={labelCls}>
            Solver
          </label>
          <select
            id="solver"
            className={inputCls}
            value={solver}
            onChange={(e) => setSolver(e.target.value as SolverChoice)}
          >
            {SOLVERS.map((s) => (
              <option key={s} value={s}>
                {SOLVER_LABELS[s]}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted">
            Exact proves optimality only for ≤ 8 vessels; larger instances
            fall back to greedy with a clear label.
          </p>
        </div>
        <div>
          <label htmlFor="seed" className={labelCls}>
            Seed
          </label>
          <input
            id="seed"
            className={inputCls}
            inputMode="numeric"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted">
            Integer. Same input + seed reproduces the plan.
          </p>
        </div>
      </div>

      <div>
        <label htmlFor="scenarioName" className={labelCls}>
          Run name
        </label>
        <input
          id="scenarioName"
          className={inputCls}
          maxLength={80}
          value={scenarioName}
          onChange={(e) => setScenarioName(e.target.value)}
        />
      </div>

      <button
        type="submit"
        disabled={pending}
        className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Solving…" : "Run solver"}
      </button>
    </form>
  );
}
