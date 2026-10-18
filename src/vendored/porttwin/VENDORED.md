# VENDORED — PortTwin simulation engine

> ⚠️ **DO-NOT-EDIT POLICY**: The files under `sim/` are vendored verbatim from the
> PortTwin repository. Never edit them by hand. If a fix is needed upstream, make
> the change in the PortTwin repo, re-verify its test suite there, and re-copy the
> file(s) verbatim, recording the new source SHA below.

> ⚠️ **MODEL STATUS: UNCALIBRATED** — This simulation model has NOT been calibrated
> against real port data. Its KPIs (wait times, throughput, utilization) reflect the
> model's internal parameters and seeded randomness, not measured port operations.
> Do not present its outputs as validated facts about any real port until a
> calibration pass against observed data has been done.

## Source

- Repository: `~/workspace/port-harden/porttwin` (branch `harden/porttwin-phase-e`) — **read-only**
- Commit: `bbed11b` (verified `git rev-parse HEAD` = `bbed11baa4dd2fbd3d7ef360b571653d7d8be9d2`, clean working tree at copy time)
- Copied: 2026-10-18 (byte-identical copies, `diff` clean against source)

## Files vendored (original path → vendored path)

| Original (`porttwin/src/sim/`) | Vendored (`src/vendored/porttwin/sim/`) | What it is |
|---|---|---|
| `rng.ts` | `sim/rng.ts` | Seeded RNG (`mulberry32`) + sampling distributions (uniform, exponential, lognormal) |
| `types.ts` | `sim/types.ts` | `SimParams`, `SimResult`, `Kpis`, `Truck`, snapshots, run options |
| `disruptions.ts` | `sim/disruptions.ts` | Disruption schedules (crane breakdowns, gate closures, yard productivity) |
| `stats.ts` | `sim/stats.ts` | Mean/std, confidence intervals, t-quantiles — pure stats helpers |
| `engine.ts` | `sim/engine.ts` | Core discrete-event simulation (`runSimulation`) |
| `costs.ts` | `sim/costs.ts` | Cost breakdown from simulation results |
| `montecarlo.ts` | `sim/montecarlo.ts` | Phase B replication scheme (`baseSeed … baseSeed+replications−1`) + `summarizeSamples` |
| `scenarios.ts` | `sim/scenarios.ts` | `DEFAULT_PARAMS` + scenario definitions (pure) |
| `validate.ts` | `sim/validate.ts` | Schema-versioned validation of `SimParams` / disruption payloads |
| `datasets.ts` | `sim/datasets.ts` | Zod schema for validation datasets (model-vs-reality comparison inputs) |
| `contracts.ts` | `sim/contracts.ts` | **Zod I/O contracts**: `SimulationInputSchema`, `SimulationOutputSchema`, `loadSimulationInput`, `inputHash`, `assertValidOutput` |
| `errors.ts` | `sim/errors.ts` | Structured `SimError` type + `toPublicError` |
| `audit.ts` | `sim/audit.ts` | In-memory append-only audit trail (DEMO-ONLY, does not survive restarts) |
| `service.ts` | `sim/service.ts` | **`runScenario(rawInput, options?)`** — the validated, single entry point |

## Entry points

- **Simulation core**: `runSimulation(params: SimParams, onSnapshot?: SnapshotCallback, options?: RunOptions): SimResult` (`sim/engine.ts`)
- **Validated service**: `runScenario(rawInput: unknown, options?: RunScenarioOptions): SimulationOutput` (`sim/service.ts`) —
  validate-first against `SimulationInputSchema`, idempotent result cache keyed on
  `(inputHash, idempotencyKey)`, Monte Carlo replication, output validated against
  `SimulationOutputSchema`, audit event appended.

## Determinism guarantees (preserved)

- All randomness flows from `mulberry32(p.seed)` in `sim/rng.ts`; no `Math.random()`
  anywhere in the vendored set. Same `SimParams` ⇒ same `SimResult`, bit-for-bit.
- `runScenario` extends determinism across replications via the baseSeed + replication
  scheme in `sim/montecarlo.ts` and a canonical `inputHash` (stable stringify) in
  `sim/contracts.ts`.

## Import adjustments

**None.** All vendored files use only relative `./` imports within `sim/`, and the
`sim/` relative structure was preserved, so every import resolves unchanged.
Both repos use zod `^4.6.7`, so the contract schemas need no adaptation.

## Deliberately NOT copied

- `sim/index.ts` — re-exports skipped modules (`vv`, `sensitivity`, …); would not compile standalone.
- `sim/export.ts` — imports DOM (`document.createElement` for CSV download); browser-only.
- `sim/storage.ts` — localStorage-backed scenario persistence (browser-specific).
- `sim/auth.ts`, `sim/http.ts` — auth/session and HTTP error translation layers; not needed for the engine.
- `sim/vv.ts`, `sim/sensitivity.ts`, `sim/calibration.ts`, `sim/doe.ts`, `sim/outputAnalysis.ts` — V&V/analysis utilities; pure but outside this slice's scope (calibration pass still open as future work).
- `sim/erlang.ts` — pure but unreferenced by the engine/service; skipped.
- React components, pages/routes, CSS, tests — per vendoring rules.
