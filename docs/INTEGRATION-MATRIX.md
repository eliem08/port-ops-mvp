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
| `optimizer.ts`, `annealer.ts`, `exact.ts`, `formulation.ts`, `pareto.ts`, `predictor.ts`, `pricing.ts`, `replan.ts`, `statistics.ts`, `stochastic.ts`, `simulation.ts`, `data.ts`, `csv.ts`, `request-validation.ts` | No | Slot-optimization engine vendored but **not imported anywhere in platform code** (verified: zero imports of `src/vendored/tas/` outside the vendor drop); no UI page or API route calls the TAS optimizer. Platform appointments are CRUD + state machine. |
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
| `lib/exact.ts` (`solveExact`, `EXACT_MAX_VESSELS = 8`) | Yes — `src/lib/planning.ts` | Hard ceiling enforced on the *input* vessel count; `proven_optimal = 1` only when `solveExact` exhausts its search (node cap 2 000 000 may leave it `0`); falls back to labeled greedy above 8 vessels |
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

## UI pages — executable capabilities (2026-10-19)

Every page is a real, working surface. Server components read the database
directly; client forms either call a UI server action (`src/lib/actions.ts`)
or POST to the REST API. Nothing is mocked.

| Page | Module | What it does | Mutation path |
|---|---|---|---|
| `/` (dashboard) | all four | Live counts: appointments by status, verification outcomes, pending reviews, plans by solver, simulations by scenario, recent audit tail | read-only (`src/lib/dashboard.ts`) |
| `/login` | auth | Demo login (five roles) | `POST /api/auth/login` |
| `/appointments` | TAS | List appointments, filter by status | read-only (`src/lib/appointments.ts`) |
| `/appointments/new` | TAS | Create an appointment (plate, container, driver, UTC-Z slot) | server action `createAppointmentAction` |
| `/appointments/[id]` | TAS | Appointment detail + legal status-transition buttons | server action `transitionAppointmentAction` |
| `/gate` | GateWatch | Simulated scan form (appointment ref, plate/container reads, confidence) | server action `submitScanAction` → `recordScanVerification` (`src/lib/demo-workflow.ts`) |
| `/gate/reviews` | GateWatch | Human-review queue; supervisor approve/reject with note | server action `decideReviewAction` → `decideReviewItem` (`src/lib/demo-workflow.ts`) |
| `/planning` | BerthWise | New-plan form (synthetic preset + solver) + run list | `POST /api/planning/runs` (REST) |
| `/planning/runs/[id]` | BerthWise | Plan detail: assignments, KPIs, optimality badge, assumptions | read-only |
| `/simulate` | PortTwin | New-run form + **explicit bridge card** (appointment volume → overrides, all assumptions editable) + run list + compare picker | server actions `createSimulationRunAction`, `createSimulationRunFromAppointmentsAction` |
| `/simulate/runs/[id]` | PortTwin | Run detail: KPIs, applied params, assumptions (bridge assumptions shown first) | read-only |
| `/simulate/compare` | PortTwin | Baseline vs proposed KPI deltas (two run ids) | read-only (`compareSimulationRuns`) |

The **explicit bridge** (`/simulate` card + `src/lib/demo-workflow.ts` +
`src/app/simulate/bridge-form.tsx`) is the ONLY cross-module workflow that
connects TAS data to another module. It is parametric, not structural:
appointment volume on one date proposes `trucksPerDay`/`horizonHours`
overrides; every assumption is shown and editable before the run, stored
verbatim on the run, and folded into the idempotency hash. Full chain is
covered by `src/lib/demo-workflow.test.ts`.

## API route → domain lib → vendored module map (2026-10-19)

| Route | Domain lib | Vendored module reached |
|---|---|---|
| `POST/GET /api/appointments` | `src/lib/appointments.ts` | TAS: status enum + UTC discipline (contract reuse only) |
| `GET /api/appointments/[id]` | `src/lib/appointments.ts` | TAS: contract reuse only |
| `PATCH /api/appointments/[id]/status` | `src/lib/appointments.ts` (`setAppointmentStatus`) | TAS: `STATUS_TRANSITIONS` state machine |
| `POST /api/gate/scans` | `src/lib/appointments.ts` (`getAppointment`, `setAppointmentStatus` for check-in) | GateWatch: `review.ts` (`routeScan`, `needsReview`, threshold 70) |
| `GET /api/gate/reviews`, `POST /api/gate/reviews/[id]/decide` | direct DB (review queue owned by the platform) | GateWatch: decision vocabulary only |
| `POST/GET /api/planning/runs`, `GET /api/planning/runs/[id]` | `src/lib/planning.ts` | BerthWise: `berth.ts`, `ga.ts`, `exact.ts`, `validate.ts` |
| `POST/GET /api/simulate/runs`, `GET /api/simulate/runs/[id]` | `src/lib/simulation.ts` | PortTwin: `service.ts`, `scenarios.ts`, `contracts.ts`, `errors.ts` |
| `GET /api/simulate/compare` | `src/lib/simulation.ts` (`compareSimulationRuns`) | PortTwin: output DTOs only |
| `GET /api/dashboard` | `src/lib/dashboard.ts` | none (raw counts) |
| `GET /api/health` | none | none |
| `POST /api/auth/*` | `src/lib/auth.ts` | none (demo JWT) |

The UI server actions (`src/lib/actions.ts`) deliberately bypass the REST
routes: `createAppointmentAction`, `transitionAppointmentAction`,
`submitScanAction`, `decideReviewAction` (→ `src/lib/demo-workflow.ts`),
`createSimulationRunAction`, `createSimulationRunFromAppointmentsAction`.
REST↔action parity for the gate workflow (auto-accept check-in, degrade to
human-review, separation of duties, 60/min throttle, atomic persistence) is
locked by `src/lib/actions-security.test.ts`.

## Shared database records between modules (2026-10-19)

| Table | Written by | Read by | Relationship |
|---|---|---|---|
| `appointments` | TAS UI + API | GateWatch scans (server-side ref), dashboard, bridge summary | `gate_verification_events.appointment_id` → `appointments.id` (FK) |
| `gate_verification_events` | GateWatch scans | review queue, dashboard | `review_items.event_id` → `gate_verification_events.id` (FK, UNIQUE) |
| `review_items` | GateWatch (scan routing) + supervisors (decisions) | review queue, dashboard | join to events; no link to appointments except through the event |
| `berth_plans` | BerthWise runs | planning pages, dashboard | **standalone** — no FK to appointments or any other module |
| `simulation_runs` | PortTwin runs (incl. bridge runs) | simulator pages, dashboard | **standalone** — no FK to appointments; the bridge is parametric (assumptions text only) |
| `audit_events` | all modules | dashboard (recent tail) | cross-cutting: `(entity, entity_id)` indexes, no FKs |
| `idempotency_keys` | appointments | appointments | replay guard for appointment creation |
| `demo_users` | seed | everything (`created_by`, `actor_id`) | convention only, no FKs |

## Missing links — NOT implemented (honest list, 2026-10-19)

1. **TAS optimizer not wired.** `src/vendored/tas/optimizer.ts` (+ annealer,
   exact, formulation, pareto, predictor, pricing, replan, statistics,
   stochastic, simulation) is imported nowhere. Decision documented in
   `docs/TAS-OPTIMIZER-DECISION.md` — the input contract (`BookingRequest`)
   requires cargo/move/preferred windows/lead-time/no-show data the platform
   never collects; fabricating defaults would violate the no-fake-data rule.
2. **No appointment → berth-plan link.** BerthWise runs reference no
   appointment data at all. The demo workflow deliberately bridges to
   PortTwin (truck volume is the natural fit), not to berth allocation.
3. **No BerthWise ↔ PortTwin coupling.** Plans and simulations never
   reference each other; the compare page compares two simulation runs only.
4. **GateWatch `tas-adapter.ts` not wired.** Superseded by the server-side
   ID lookup — the platform never trusts client-supplied appointment data.
5. **TAS recommendation contracts not wired.** The versioned
   reschedule / cancel-booking / reallocate-gate / notify-carrier payloads
   (`recommendation.ts`) have no UI or API surface.
6. **PortTwin engine in-memory audit not used.** The platform persists to
   SQLite instead (deliberate; the engine audit is not reachable).
7. **The bridge is one-directional and parametric.** Assumptions travel as
   text on the run; nothing structural (no FK, no slot feed) connects TAS to
   PortTwin, and nothing flows back.

## Test coverage (`npm run test` — 263 tests, 19 files, all green — verified 2026-10-19)

| Test file | Tests | Covers |
|---|---|---|
| `src/lib/state-machine.test.ts` | 42 | Appointment status state machine |
| `src/lib/security.test.ts` | 28 | Security regression (auth, validation, replay, fail-closed) |
| `src/app/api/gate/gate-routes.test.ts` | 23 | Gate API routes: auth gates, validation, scan routing |
| `src/lib/planning.test.ts` | 22 | Planning domain: solver mapping, input hashing, provenance labels, idempotency |
| `src/lib/simulation.test.ts` | 19 | Simulation domain: preset binding, provenance labels, uncalibrated notice, error mapping |
| `src/app/api/appointments/appointments-routes.test.ts` | 18 | Appointment API routes: auth gates, validation, idempotent replays |
| `src/contracts/contracts.test.ts` | 17 | Unified Zod contracts: status transitions, UTC-Z datetimes, scan input, plan/simulation inputs |
| `src/app/api/simulate/simulate-routes.test.ts` | 13 | Simulation API routes + compare: auth gates, validation, idempotent replays |
| `src/app/api/planning/runs/route.test.ts` | 11 | Planning API routes: auth gates, validation, idempotent replays |
| `src/lib/audit-trail.test.ts` | 10 | Append-only audit trail |
| `src/app/api/auth/auth-routes.test.ts` | 9 | Auth routes: login/logout/me, session handling |
| `src/vendored/gatewatch/review.regression.test.ts` | 8 | Fail-closed regression: NaN/missing/101 confidence never auto-accepts |
| `src/lib/auth-secret.test.ts` | 7 | Secret handling, startup refusal behavior |
| `src/app/api/idempotency.test.ts` | 6 | Idempotency across routes |
| `src/lib/limitations.test.ts` | 6 | Limitation verification: replay, atomicity, provenance |
| `src/app/api/dashboard/dashboard-route.test.ts` | 5 | Dashboard counts reflect real mutations |
| `src/lib/demo-scenario.test.ts` | 1 | Demo scenario integrity |
| `src/lib/demo-workflow.test.ts` | 6 | Cross-module workflow: appointment → scan → review → decision → bridge → baseline-vs-proposed compare |
| `src/lib/actions-security.test.ts` | 12 | UI action parity with REST: separation of duties, decision validation, atomic scan persistence, auto-accept check-in + degrade, scan throttle |
| **Total** | **263** | — |

**Coverage gaps (known):**

1. The vendored BerthWise, PortTwin, and TAS logic is covered by its **upstream**
   test suites (BerthWise/PortTwin/TAS/GateWatch repos), not re-run here — the
   platform tests cover the integration seams, not the vendored internals.
   (Exception: the GateWatch fail-closed regression, which is deliberately
   duplicated here.)
2. UI pages (React components) have no tests; `src/test-utils/sqlite-shim.ts`
   is test-only infrastructure.

(Resolved 2026-10-18: the previously broken `appointments-routes.test.ts`
— missing `@/test-utils/route-harness` — is now fixed, tracked, and passing.)
