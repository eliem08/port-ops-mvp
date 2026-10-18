# BerthWise — vendored business logic

> **DO-NOT-EDIT POLICY.** This directory is a read-only vendor drop of the
> BerthWise planning solver. **Never edit these files by hand.** If the solver
> needs to change, change it in the source repo
> (`~/workspace/port-harden/berthwise`, branch `harden/berthwise-phase-e`),
> re-verify it there, and re-copy the files verbatim. Hand-edits here will be
> silently lost on the next re-vendor and will break the guarantee that the
> platform runs exactly the solver that was reviewed and tested upstream.

## Source

- Repo: `~/workspace/port-harden/berthwise` (**read-only for this platform**)
- Branch: `harden/berthwise-phase-e`
- Commit: `3f719c71fb06978c832dea46cc277d0c5e22f683` (SHA `3f719c7`)
- Vendored: 2026-10-18
- Method: verbatim `cp` of the listed files, preserving relative structure
  (`src/lib/*` → `src/vendored/berthwise/lib/*`,
  `src/contracts/*` → `src/vendored/berthwise/contracts/*`).
  All inter-file imports were already relative (`./types`, `./rng`, …) so no
  import-path adjustments were required. Zod versions match between the two
  repos (`^4.6.7`).

## Files copied (verbatim)

### Solver / pure-logic modules

| Vendored file | Original path |
|---|---|
| `lib/types.ts` | `src/lib/types.ts` |
| `lib/rng.ts` | `src/lib/rng.ts` |
| `lib/validate.ts` | `src/lib/validate.ts` |
| `lib/tide.ts` | `src/lib/tide.ts` |
| `lib/economics.ts` | `src/lib/economics.ts` |
| `lib/cranes.ts` | `src/lib/cranes.ts` |
| `lib/berth.ts` | `src/lib/berth.ts` |
| `lib/alns.ts` | `src/lib/alns.ts` |
| `lib/ga.ts` | `src/lib/ga.ts` |
| `lib/exact.ts` | `src/lib/exact.ts` |

### Zod contract schemas

| Vendored file | Original path |
|---|---|
| `contracts/berth-plan.ts` | `src/contracts/berth-plan.ts` |
| `contracts/vessel-schedule.ts` | `src/contracts/vessel-schedule.ts` |
| `contracts/shared.ts` | `src/contracts/shared.ts` |
| `contracts/audit-event.ts` | `src/contracts/audit-event.ts` |
| `contracts/recommendation.ts` | `src/contracts/recommendation.ts` |
| `contracts/resource.ts` | `src/contracts/resource.ts` |
| `contracts/index.ts` | `src/contracts/index.ts` |

## Solvers available

All planners take `(Vessel[], Berth[], opts: PlanOptions = {})` and return a
`BerthPlan`. They are pure, deterministic for a fixed `opts.seed` (default 42),
and have no React / Next / DOM / Node dependencies.

- `planNaive` / `planGreedy` — `lib/berth.ts:287–298`. Greedy baseline
  (`planGreedy` is an alias of `planNaive`).
- `planOptimized` — `lib/berth.ts:406`. Simulated annealing (SA_TEMP_START 8 →
  SA_TEMP_END 0.02, time-budgeted, default 500 ms).
- `planTabu` — `lib/berth.ts:468`. Tabu search, relocate-one-vessel
  neighbourhood, tabu tenure 12, 8 candidate moves/iteration.
- `planGA` — `lib/ga.ts:160`. Genetic algorithm (seeded with the greedy plan).
- `planALNS` — `lib/alns.ts:201`. Adaptive Large Neighborhood Search
  (Ropke & Pisinger 2006; destroy/repair, 400 fixed iterations).
- `solveExact(vessels, berths, opts, nodeCap = 2_000_000, prune = true)` —
  `lib/exact.ts:210`. Branch-and-bound exact solver, returns `ExactResult`
  (with `provenOptimal` flag).

Supporting pure helpers: `berthFeasible(vessel, berth)` (length + grain-capability
check), `planToSequences` / `sequencesToPlan` (sequence ↔ plan conversion),
`validateMove` / `rebuildAfterMove` (drag-validation), `compareAlgorithms` /
`assertFairComparison` / `comparisonFingerprint`, `mulberry32(seed)` (seeded RNG),
`assertPlanningInputs` / `assertValidVessel` / `assertValidBerth`,
`tide` windows, crane economics (`planEconomics`, `cranesForVessel`,
`CRANE_POOL_LIMIT`), `gapAgainstExact`.

Contract schemas: `BerthPlanSchema` (`contracts/berth-plan.ts`),
`VesselScheduleSchema` (`contracts/vessel-schedule.ts`), both Zod 4.

## Import-cycle note (read this before wiring imports)

Upstream has a **circular import** between the planner modules:
`berth.ts` ↔ `ga.ts` ↔ `alns.ts` ↔ `exact.ts`
(`berth` imports `planGA` from `./ga` and `planALNS` from `./alns`;
`ga`, `alns`, and `exact` all import `berthFeasible`/`planNaive`/`planToSequences`/
`sequencesToPlan` from `./berth`).

The files were copied **as-is** (verbatim), so the cycle comes with them.
ESM circular imports like this work in practice (only functions are referenced,
all calls happen after module evaluation), but **do not import through the
contracts-style barrel for these modules** — there is no solver barrel, and you
should keep it that way. Import from the specific file you need:

```ts
import { planOptimized, planTabu, planGreedy } from "@/vendored/berthwise/lib/berth";
import { planGA } from "@/vendored/berthwise/lib/ga";
import { planALNS } from "@/vendored/berthwise/lib/alns";
import { solveExact, EXACT_MAX_VESSELS } from "@/vendored/berthwise/lib/exact";
```

The Zod contracts DO have a barrel (`contracts/index.ts`); that one is acyclic
and safe to use.

## Solver ceilings & scaling limits

- **`solveExact` — hard ceiling of 8 vessels.** `EXACT_MAX_VESSELS = 8`
  (`lib/exact.ts:52`); `solveExact` throws when more than 8 placeable vessels
  are passed. Complexity is exponential; the docstring notes "practical limit:
  ≤ 8 vessels". Use it to grade heuristics on small subsets / benchmark
  instances, never on live data.
- **ALNS — superlinear scaling; do NOT put on the interactive path.**
  The regret-2 repair operator evaluates *every* feasible (berth, position)
  insertion by full re-sweep; per-iteration cost grows superlinearly with
  vessel count. It runs 400 fixed iterations (deterministic), so it is a
  bounded batch/offline optimizer — never await it inside a user-facing request.
- **SA / tabu / GA** — time-budgeted (default 500 ms via `opts.timeLimitMs`)
  and seed-deterministic; these are the safe interactive-path candidates.

## Files deliberately skipped (not vendored)

- All tests: `src/lib/__tests__/**`
- React/Next surface: `src/app/**` (API routes), CSS, pages
- Server plumbing: `src/lib/auth.ts`, `demo-auth.ts`, `data.ts` (fixtures),
  `plan-service.ts`, `http.ts`, `idempotency.ts`, `rate-limit.ts`, `logger.ts`,
  `result.ts`, `audit.ts`, `csv.ts` (CSV export)
- Extra pure modules not on the solver import closure, kept out to keep the
  vendor drop minimal: `eta.ts`, `robust.ts`, `kpi.ts`, `yard.ts`,
  `relocation.ts`, `benchmarks.ts`, `src/datasets/**`
- Docs: `docs/**`, `fixtures/**`

## Re-vendoring

```bash
SRC=~/workspace/port-harden/berthwise/src
DST=~/workspace/port-ops-mvp/src/vendored/berthwise
mkdir -p "$DST/lib" "$DST/contracts"
for f in berth alns ga exact types rng validate tide economics cranes; do cp "$SRC/lib/$f.ts" "$DST/lib/$f.ts"; done
for f in index berth-plan vessel-schedule shared audit-event recommendation resource; do cp "$SRC/contracts/$f.ts" "$DST/contracts/$f.ts"; done
```

Then update the Source section above with the new SHA/date.

---

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

---

# VENDORED — TAS truck appointment coordination (tas-casablanca)

> **DO-NOT-EDIT POLICY.** This directory is a read-only vendor drop of the
> TAS appointment contracts and slot-optimization engine. **Never edit these
> files by hand.** Changes happen in the source repo
> (`~/workspace/port-harden/tas-casablanca`, Phase E HEAD), are re-verified
> there, and are re-copied verbatim. See `docs/INTEGRATION-MATRIX.md` for the
> full module-level integration table.

## Source

- Repository: `~/workspace/port-harden/tas-casablanca` (Phase E HEAD) — **read-only**
- Commit: `7cdaaf8245afb566636abc7916d5907244a23d4d` (short SHA `7cdaaf8`;
  verified `git rev-parse HEAD`, clean working tree)
- Vendored: 2026-10-18
- Method: verbatim `cp` of 25 files, preserving relative structure
  (`lib/*` → `src/vendored/tas/*`, `lib/contracts/*` → `src/vendored/tas/contracts/*`,
  `lib/datasets/*` → `src/vendored/tas/datasets/*`,
  `lib/server/*` → `src/vendored/tas/server/*`). All imports were already
  relative, so no import-path adjustments were required.

> SHA attribution note: no VENDORED.md section was written at copy time, so
> the SHA above was recovered on 2026-10-18 by byte-diffing every vendored
> file against the upstream working tree (clean) — see INTEGRATION-MATRIX.

## Files vendored (25)

| Vendored file | Original path | What it is |
|---|---|---|
| `contracts/appointment.ts` | `lib/contracts/appointment.ts` | `AppointmentStatus` 6-status enum, state machine, `APPOINTMENT_CONTRACT_VERSION = "1.0.0"` — the contract reuse source |
| `contracts/index.ts` | `lib/contracts/index.ts` | Contract barrel |
| `contracts/recommendation.ts` | `lib/contracts/recommendation.ts` | Recommendation contract |
| `types.ts` | `lib/types.ts` | Shared types |
| `data.ts` | `lib/data.ts` | Synthetic data helpers |
| `csv.ts` | `lib/csv.ts` | CSV export |
| `datasets/schemas.ts` | `lib/datasets/schemas.ts` | Dataset schemas |
| `request-validation.ts` | `lib/request-validation.ts` | Request validation helpers |
| `optimizer.ts` | `lib/optimizer.ts` | Slot optimizer |
| `annealer.ts` | `lib/annealer.ts` | Annealing optimizer |
| `exact.ts` | `lib/exact.ts` | Exact optimizer |
| `formulation.ts` | `lib/formulation.ts` | Optimization formulation |
| `pareto.ts` | `lib/pareto.ts` | Pareto frontier |
| `predictor.ts` | `lib/predictor.ts` | Demand predictor |
| `pricing.ts` | `lib/pricing.ts` | Slot pricing |
| `replan.ts` | `lib/replan.ts` | Replanning |
| `statistics.ts` | `lib/statistics.ts` | Slot statistics |
| `stochastic.ts` | `lib/stochastic.ts` | Stochastic optimization |
| `simulation.ts` | `lib/simulation.ts` | TAS-side simulation |
| `server/audit.ts` | `lib/server/audit.ts` | Upstream audit helper |
| `server/auth.ts` | `lib/server/auth.ts` | Upstream auth helper |
| `server/idempotency.ts` | `lib/server/idempotency.ts` | Upstream idempotency helper |
| `server/logger.ts` | `lib/server/logger.ts` | Upstream logger |
| `server/rate-limit.ts` | `lib/server/rate-limit.ts` | Upstream rate limiter |
| `server/stores.ts` | `lib/server/stores.ts` | Upstream stores |

## Wiring status (verified 2026-10-18 — grep for imports of `src/vendored/tas/`)

**Nothing under `src/vendored/tas/` is imported by any platform code — zero
imports outside the vendor drop.** Concretely:

- **Slot-optimization engine** (`optimizer.ts`, `annealer.ts`, `exact.ts`,
  `formulation.ts`, `pareto.ts`, `predictor.ts`, `pricing.ts`, `replan.ts`,
  `statistics.ts`, `stochastic.ts`): vendored for provenance only. **No UI
  page and no API route calls the TAS optimizer** — the claim "vendored but
  not on interactive path" in `docs/INTEGRATION-MATRIX.md` is accurate.
- **Server helpers** (`server/audit.ts`, `server/auth.ts`,
  `server/idempotency.ts`, `server/logger.ts`, `server/rate-limit.ts`,
  `server/stores.ts`): **not wired** — the platform implements its own
  auth (`src/lib/auth.ts`), idempotency (SQLite UNIQUE + transactions), and
  audit (`src/lib/audit.ts`). Note the platform's rate limiter is its own
  `src/lib/rate-limit.ts` (in-memory token bucket), **not** the vendored TAS
  one.
- **Contract influence only:** the platform *re-declares* the TAS
  `AppointmentStatus` enum and UTC-Z datetime discipline in
  `src/contracts/index.ts` (cited as source of truth — TAS contract v1.0.0)
  rather than importing them from the vendor drop.

## Verification method

- Every vendored file is byte-identical to upstream at the recorded SHA
  (byte-verified 2026-10-18; spot re-checked today:
  `contracts/appointment.ts` and `optimizer.ts` — `diff` clean against
  upstream working tree).

---

# VENDORED — GateWatch gate-scan verification (gatewatch)

> **DO-NOT-EDIT POLICY.** This directory is a read-only vendor drop of the
> GateWatch verification logic. **Never edit these files by hand.** Changes
> happen in the source repo (`~/workspace/port-harden/gatewatch`, Phase E
> HEAD), are re-verified there, and are re-copied verbatim. See
> `docs/INTEGRATION-MATRIX.md` for the full module-level integration table.

## Source

- Repository: `~/workspace/port-harden/gatewatch` (Phase E HEAD) — **read-only**
- Commit: `9e70c2f3d933c015a8a9408bf3767905e10f7078` (short SHA `9e70c2f`;
  verified `git rev-parse HEAD`, clean working tree)
- Vendored: 2026-10-18
- Method: verbatim `cp` of 7 files, preserving relative structure
  (`src/lib/*` → `src/vendored/gatewatch/*`). All imports were already
  relative, so no import-path adjustments were required.

> SHA attribution note: no VENDORED.md section was written at copy time, so
> the SHA above was recovered on 2026-10-18 by byte-diffing every vendored
> file against the upstream working tree (clean) — see INTEGRATION-MATRIX.

## Files vendored (7)

| Vendored file | Original path | What it is | Wired into platform? |
|---|---|---|---|
| `review.ts` | `src/lib/review.ts` | `routeScan`, `needsReview`, `DEFAULT_REVIEW_THRESHOLD = 70` | **Yes** — `POST /api/gate/scans` |
| `verify.ts` | `src/lib/verify.ts` | `verifyGateEventAgainstAppointment` | **Yes** — `submitScanAction` (`src/lib/actions.ts`, dynamic import) |
| `contracts.ts` | `src/lib/contracts.ts` | Decision vocabulary contracts | No — provenance only |
| `iso6346.ts` | `src/lib/iso6346.ts` | ISO 6346 container check-digit | No — provenance only |
| `plates.ts` | `src/lib/plates.ts` | Plate parsing helpers | No — provenance only |
| `tas-adapter.ts` | `src/lib/tas-adapter.ts` | TAS payload reconciliation | No — not on the interactive path; superseded by the platform's server-side appointment-ID lookup |
| `review.regression.test.ts` | `src/lib/review.regression.test.ts` | Fail-closed regression (8 tests) | **Yes** — runs in the platform test suite |

## Verification method

- Every vendored file is byte-identical to upstream at the recorded SHA
  (byte-verified 2026-10-18; spot re-checked today:
  `review.ts` and `tas-adapter.ts` — `diff` clean against upstream working
  tree).
