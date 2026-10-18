# TAS optimizer — wiring decision: NOT wired (2026-10-19)

Status: **deliberately not on any interactive path**. This document records
the assessment so the decision is explicit, not an oversight. Revisit when
the platform collects the optimizer's required inputs.

## What the optimizer is

`src/vendored/tas/optimizer.ts` (SHA `7cdaaf8`) — a slot-allocation
optimizer for truck appointments with three strategies:

- `optimizeSlots(requests, { method: 'greedy' })` — greedy assignment
  (preferred window first, least-loaded gate/slot) + 250-iteration
  local-search improvement;
- `optimizeSlots(requests, { method: 'annealed' })` — greedy + local search
  + 2 500 simulated-annealing moves (best-seen kept, never worse than
  greedy on the shared cost function);
- `baselineAssign(requests)` — first-come-first-served status quo for
  comparison.

Supporting modules: `annealer.ts`, `exact.ts`, `formulation.ts`, `pareto.ts`,
`predictor.ts` (no-show probabilities), `pricing.ts`, `replan.ts`,
`statistics.ts`, `stochastic.ts`, `simulation.ts`, `data.ts`, `csv.ts`,
`request-validation.ts`. Zero imports of `src/vendored/tas/` anywhere in
platform code (verified 2026-10-18).

## Input contract

`BookingRequest` (`src/vendored/tas/types.ts`) — every field is required
unless noted:

| Field | Type | The platform has it? |
|---|---|---|
| `id` | string | ✅ (appointment id) |
| `company` | string | ❌ not collected |
| `truckPlate` | string | ✅ |
| `cargo` | `general \| grain \| reefer \| hazmat` | ❌ not collected |
| `move` | `import \| export` | ❌ not collected |
| `containers` | 1 \| 2 | ❌ not collected |
| `preferredStart` / `preferredEnd` | minutes since midnight | ❌ — the platform stores one free-form `scheduled_at` (UTC-Z), not a window |
| `leadTimeHours` | number | ⚠️ derivable (created_at → scheduled_at) |
| `driverNoShowRate` | 0..1 | ❌ not collected (only `predictor.ts` models exist, calibrated upstream) |
| `createdAt` | epoch ms | ✅ (created_at) |
| `day` | 0..6 (optional) | ⚠️ derivable from scheduled_at |
| `terminal` | T1 \| T2 \| T3 \| 'any' (optional) | ❌ — the platform has no gate/terminal model at all |

**Verdict on inputs:** 6 of 11 fields are missing and non-derivable. The
optimizer's world model — 3 gates (express/standard/inspection) × 32
thirty-minute slots × 7-day horizon — does not match the platform's model,
which has no gates, no terminals, and free-form slots. Wiring it today would
require **fabricating** cargo types, preferred windows, and terminal
preferences for every appointment. That is exactly the kind of fake
integration this hardening branch refuses to ship.

## Output

`SlotAssignment[]`: per-truck `{ requestId, gate, slotStart, rescheduled,
noShowProbability, waitEstimateMin, day, terminal }`, plus `scorePlan()` KPIs
(cost, maxLoad, rescheduled count, total/avg wait).

**Interpretability:** genuinely demo-friendly — "truck X moved from the 08:00
rush to 10:30, peak gate load 7 → 4, average wait 22 → 9 min" is a story a
port audience understands. The output is NOT the problem; the inputs are.

## Operational relevance

High in principle: slot allocation is the core TAS value proposition
(the ENSEM benchmark cited in the vendored docs: −62% max queue on real
Casablanca port data). But relevance requires the booking model to exist —
preferred windows, gates, terminals — and the platform deliberately scoped
slice 1 to CRUD + state machine + gate verification.

## Decision

**Do not wire.** An honest "not wired" beats a confusing integration that
invents cargo types and preferred windows behind the user's back.

## What wiring would need (checklist for a future slice)

1. **Booking model extension** — collect on the appointment form (or a batch
   import): preferred window (start/end), gate or terminal preference,
   cargo type, move (import/export), container count. All user-supplied or
   explicitly defaulted with the default shown, never silently invented.
2. **A batch UI** — the optimizer optimizes a *day's bookings*, not one
   appointment. Needs a "optimize today's slot plan" page taking N
   appointments and returning baseline (`baselineAssign`) vs optimized
   (`optimizeSlots`) with `scorePlan()` deltas.
3. **Gate model** — the platform currently has no gates/terminals; the
   optimizer assigns to gates 0–2 at terminals T1–T3. Either map to real gate
   identities or label the 3-gate model as the vendored demo abstraction it is.
4. **No-show calibration** — `driverNoShowRate` / `predictor.ts` are
   calibrated upstream on unknown data; document or re-calibrate before any
   operational use.
5. **Write-back policy** — decide what an optimized plan DOES: propose
   reschedules as TAS *recommendations* (`recommendation.ts` contract,
   proposed → approved/rejected) rather than silently rewriting slots.

Until then: vendored for provenance, imported nowhere, and this file is the
receipt.
