# Integration Matrix — vendored modules, sources, adaptation, tests

Every vendored file is a verbatim copy (byte-identical to the source at the
recorded SHA). **Do-not-edit policy:** fixes go upstream, are re-verified by
the upstream test suite, then re-copied. Platform adaptation happens only at
the integration seam — never inside vendored files.

> SHA attribution note: BerthWise and PortTwin SHAs were recorded in the root
> `VENDORED.md` at copy time. TAS and GateWatch had no VENDORED.md section, so
> their SHAs below were recovered on 2026-10-18 by byte-diffing every vendored
> file against the local source repos (both working trees clean, so current
> HEAD is the true source of the copies). Future re-vendors should record the
> SHA at copy time in the root `VENDORED.md`.

## Source repos and SHAs

| Module | Source repo (GitHub) | Local path | Branch | SHA (short) | Full SHA |
|---|---|---|---|---|---|
| TAS | `eliem08/tas-casablanca` | `~/workspace/port-harden/tas-casablanca` | Phase E HEAD | `7cdaaf8` | `7cdaaf8245afb566636abc7916d5907244a23d4d` |
| GateWatch | `eliem08/gatewatch` | `~/workspace/port-harden/gatewatch` | Phase E HEAD | `9e70c2f` | `9e70c2f3d933c015a8a9408bf3767905e10f7078` |
| BerthWise | `eliem08/berthwise` | `~/workspace/port-harden/berthwise` | `harden/berthwise-phase-e` | `3f719c7` | `3f719c71fb06978c832dea46cc277d0c5e22f683` |
| PortTwin | `eliem08/porttwin` | `~/workspace/port-harden/porttwin` | `harden/porttwin-phase-e` | `bbed11b` | `bbed11baa4dd2fbd3d7ef360b571653d7d8be9d2` |

Vendoring date for all four: 2026-10-18. TAS copied from `lib/` (not `src/lib/`);
GateWatch from `src/lib/`; BerthWise from `src/lib/*` + `src/contracts/*`;
PortTwin from `src/sim/`. Zod `^4.6.7` in both sides, no import adjustments needed.

## Contract reuse (unified v1.0.0 shapes — `src/contracts/index.ts`)

| Shape | Reused from | Adaptation |
|---|---|---|
| `AppointmentStatus` 6-status enum + `STATUS_TRANSITIONS` state machine | TAS contract `APPOINTMENT_CONTRACT_VERSION = "1.0.0"` (`vendored/tas/contracts/appointment.ts`) | Re-declared in the platform contract (source of truth cited in a comment — do not invent statuses); SQLite stores it as TEXT, validated by Zod |
| UTC-Z strict datetime (`DateTimeZ`) | TAS UTC-datetime discipline (same regex) | Re-declared; enforced on all API inputs |
| `SimulationScenarioId` enum | PortTwin `PRESETS` (`vendored/porttwin/sim/scenarios.ts`) | Derived at import time from the vendored preset list — cannot drift from the engine |
| `SimulationParamOverrides` allowlist | PortTwin `SimParams` | Narrow numeric subset (horizon ≤ 168 h, trucks/day ≤ 10 000, gates 1–8, service mean ≤ 60 min) applied on top of presets |
| `SolverChoice`, `VesselInput`, `BerthInput`, `CreatePlanInput` | BerthWise `Vessel`/`Berth` types + `EXACT_MAX_VESSELS` | Platform shapes mirror required solver fields; operational fields (id, line, etaHours, handlingHours, teu, origin) derived server-side at plan time; `exact` falls back to labeled greedy heuristic above 8 vessels |
| `VerificationOutcome`, `SubmitScanInput`, `VerificationRecord` | GateWatch `verify.ts`/`review.ts` decision vocabulary | Platform Zod envelopes; `simulated: true` is a literal — a real scan cannot be recorded |

## Module-level integration table

### TAS (`src/vendored/tas/`) — SHA `7cdaaf8`

| Vendored module | Used by platform | Adaptation in this slice |
|---|---|---|
| `contracts/appointment.ts`, `contracts/index.ts`, `contracts/recommendation.ts` | Yes (contract reuse, see above) | Enum + UTC discipline re-declared in platform contracts; referenced as source of truth |
| `types.ts` | No | Vendored for provenance; not imported |
| `optimizer.ts`, `annealer.ts`, `exact.ts`, `formulation.ts`, `pareto.ts`, `predictor.ts`, `pricing.ts`, `replan.ts`, `statistics.ts`, `stochastic.ts`, `simulation.ts`, `data.ts`, `csv.ts`, `request-validation.ts` | No | Slot-optimization engine vendored but **not on any interactive path in slice 1**; platform appointments are CRUD + state machine |
| `server/audit.ts`, `server/auth.ts`, `server/idempotency.ts`, `server/logger.ts`, `server/rate-limit.ts`, `server/stores.ts` | No | Not wired — platform implements its own auth/idempotency/audit on SQLite |
| `datasets/schemas.ts` | No | Vendored for provenance |
| TAS `server/api-guard.ts` | — | **Not vendored** (exists upstream, not copied) |

### GateWatch (`src/vendored/gatewatch/`) — SHA `9e70c2f`

| Vendored module | Used by platform | Adaptation in this slice |
|---|---|---|
| `review.ts` (`routeScan`, `needsReview`, `DEFAULT_REVIEW_THRESHOLD = 70`) | Yes — `POST /api/gate/scans` | Threshold 70 used as the confidence routing choke point; NaN/missing/out-of-range confidence fails closed to `human-review` |
| `verify.ts` (`verifyGateEventAgainstAppointment`) | Yes — `submitScanAction` in `src/lib/actions.ts` (dynamic import) | Appointment ref built server-side from the DB row (ID lookup); demo slot window `scheduled_at ± 1 h`; decisions mapped to `auto-accept` / `human-review` / `scan-failed` |
| `iso6346.ts`, `plates.ts`, `contracts.ts`, `tas-adapter.ts` | No | Vendored for provenance; `tas-adapter` (TAS payload reconciliation) not on the interactive path — the platform's server-side ID lookup supersedes it |
| `review.regression.test.ts` | Yes — runs in this repo's suite | Locks the fail-closed guarantees (8 tests) |

### BerthWise (`src/vendored/berthwise/`) — SHA `3f719c7`

| Vendored module | Used by platform | Adaptation in this slice |
|---|---|---|
| `lib/berth.ts` (`planGreedy`, `planOptimized`, `planTabu`) | Yes — `src/lib/planning.ts` | Heuristics run with 2 000 ms wall-clock budget (`HEURISTIC_TIME_LIMIT_MS`); seed-default 42; results DTO'd to camelCase; `proven_optimal = 0` |
| `lib/ga.ts` (`planGA`) | Yes — `src/lib/planning.ts` | Same budget/seed treatment |
| `lib/exact.ts` (`solveExact`, `EXACT_MAX_VESSELS = 8`) | Yes — `src/lib/planning.ts` | Hard ceiling enforced; `proven_optimal = 1` only here; falls back to labeled greedy above 8 vessels |
| `lib/validate.ts` (`assertPlanningInputs`) | Yes | Input assertions below the Zod boundary |
| `lib/rng.ts`, `lib/tide.ts`, `lib/economics.ts`, `lib/cranes.ts`, `lib/types.ts` | Indirectly (internal solver closure) | Not imported directly by platform code |
| `lib/alns.ts` (`planALNS`) | **No — deliberate exclusion** | Superlinear scaling; never await on the interactive path. Vendored for future batch/offline use |
| `contracts/*` (Zod barrel) | Yes — shapes inform platform contracts | Acyclic barrel; safe to import |

### PortTwin (`src/vendored/porttwin/sim/`) — SHA `bbed11b`

| Vendored module | Used by platform | Adaptation in this slice |
|---|---|---|
| `service.ts` (`runScenario`) | Yes — `src/lib/simulation.ts` | Single validated entry point: schema validation → deterministic Monte Carlo → output contract validation → public error |
| `scenarios.ts` (`PRESETS`, `presetParams`) | Yes | Preset ids feed the platform `SimulationScenarioId` enum; descriptions exposed as synthetic demo scenarios |
| `contracts.ts` (`inputHash`, `loadSimulationInput`, `SIM_INPUT_CONTRACT_VERSION`) | Yes | Canonical input hash keys idempotency (`simulation_runs.input_hash UNIQUE`) |
| `errors.ts` (`toPublicError`) | Yes | Structured errors → sanitized public envelope |
| `rng.ts`, `types.ts`, `disruptions.ts`, `stats.ts`, `engine.ts`, `costs.ts`, `montecarlo.ts`, `validate.ts`, `datasets.ts`, `audit.ts` | Indirectly (internal engine closure) | Not imported directly; note the engine's in-memory audit is **not** used — the platform persists to SQLite instead |

## Test coverage (`npm run test` — 90 tests, 6 files, all green)

| Test file | Tests | Covers |
|---|---|---|
| `src/contracts/contracts.test.ts` | 17 | Unified Zod contracts: status transitions, UTC-Z datetimes, scan input, plan/simulation inputs |
| `src/lib/planning.test.ts` | 22 | Planning domain: solver mapping, input hashing, provenance labels, idempotency |
| `src/lib/simulation.test.ts` | 19 | Simulation domain: preset binding, provenance labels, uncalibrated notice, error mapping |
| `src/app/api/planning/runs/route.test.ts` | 11 | Planning API routes: auth gates, validation, idempotent replays |
| `src/app/api/simulate/simulate-routes.test.ts` | 13 | Simulation API routes + compare: auth gates, validation, idempotent replays |
| `src/vendored/gatewatch/review.regression.test.ts` | 8 | Fail-closed regression: NaN/missing/101 confidence never auto-accepts |

**Coverage gaps (known):**

1. `src/app/api/appointments/appointments-routes.test.ts` is **untracked and
   broken** — it imports a non-existent `@/test-utils/route-harness` and fails
   at collection (`Cannot access '__vi_import_0__' before initialization`). It
   contributes 0 tests. Appointments and gate API routes have no passing route
   tests on this branch.
2. The vendored BerthWise, PortTwin, and TAS logic is covered by its **upstream**
   test suites (BerthWise/PortTwin/TAS/GateWatch repos), not re-run here — the
   platform tests cover the integration seams, not the vendored internals.
   (Exception: the GateWatch fail-closed regression, which is deliberately
   duplicated here.)
3. UI pages (React components) have no tests; `src/test-utils/sqlite-shim.ts`
   is test-only infrastructure.
