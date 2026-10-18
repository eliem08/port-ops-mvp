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
