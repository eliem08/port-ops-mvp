/**
 * lib/stochastic.ts
 *
 * Stochastic planning under no-show uncertainty — Sample Average
 * Approximation (SAA) with a chance constraint.
 *
 * The deterministic optimizer plans for the demand that was *booked*. In
 * reality a random subset shows up. This module:
 *
 *  1. Samples K no-show scenarios: each truck shows up independently with
 *     probability 1 − p_i, where p_i is the modelled no-show probability
 *     (lib/predictor.ts — a heuristic; the scenarios inherit its error).
 *  2. Evaluates any candidate plan EXACTLY on each scenario (cost of the
 *     realized subset: same cost function, loads/wait recomputed on the
 *     trucks that actually show).
 *  3. Searches a candidate set — the deterministic plan plus one plan per
 *     scenario (optimized on that scenario's realized demand, then
 *     completed for the trucks that were absent) — and picks the plan with
 *     the lowest expected cost among those satisfying the chance
 *     constraint P(any slot overflows) ≤ α.
 *
 * Honesty: the EVALUATION over sampled scenarios is exact; the SEARCH is
 * heuristic (candidate set, not full stochastic optimization). The chance
 * constraint is enforced on sampled scenarios, so it is an empirical
 * frequency, not a true probability. More scenarios → tighter estimates.
 */

import type { BookingRequest, SlotAssignment, GateId } from './types';
import {
  GATE_IDS,
  SLOTS_PER_GATE,
  startToSlotIndex,
  capacityForGate,
  serviceMinForGate,
  terminalForGate,
} from './types';
import { makeRng } from './data';
import { noShowProbability } from './predictor';
import { optimizeSlots, DEFAULT_COST_WEIGHTS } from './optimizer';

export interface StochasticOptions {
  /** Number of sampled no-show scenarios (default 25). */
  scenarios?: number;
  seed?: number;
  /** Chance-constraint level: P(any slot overflows) ≤ α (default 0.05). */
  alpha?: number;
  /** Optimizer method for candidate plans (default 'greedy'). */
  method?: 'greedy' | 'annealed';
}

export interface ScenarioEvaluation {
  /** Cost of the plan on this scenario's realized demand. */
  cost: number;
  /** Peak realized slot load. */
  maxLoad: number;
  /** True if any slot's realized load exceeds base capacity. */
  overflow: boolean;
  /** Number of overflowed slots. */
  overflowSlots: number;
  /** Trucks that showed up in this scenario. */
  shownTrucks: number;
}

export interface CandidateEvaluation {
  label: string;
  assignments: SlotAssignment[];
  expectedCost: number;
  worstCost: number;
  /** Empirical P(any slot overflows) across scenarios. */
  overflowProb: number;
  satisfiesChance: boolean;
}

export interface StochasticResult {
  scenarios: number;
  alpha: number;
  seed: number;
  deterministic: CandidateEvaluation;
  chosen: CandidateEvaluation;
  /** True if the chosen plan satisfies the chance constraint. */
  chanceSatisfied: boolean;
  /** Expected-cost improvement of chosen vs deterministic (≥ 0 by construction). */
  expectedImprovement: number;
  /** All candidates evaluated (deterministic + one per scenario). */
  candidates: CandidateEvaluation[];
}

/** Sample K no-show scenarios: each a set of request ids that SHOW UP. */
export function generateNoShowScenarios(
  requests: BookingRequest[],
  k: number,
  seed = 42,
): Array<Set<string>> {
  const rng = makeRng(seed);
  const out: Array<Set<string>> = [];
  for (let s = 0; s < k; s++) {
    const shown = new Set<string>();
    for (const r of requests) {
      const p = noShowProbability({
        leadTimeHours: r.leadTimeHours,
        driverNoShowRate: r.driverNoShowRate,
        slotStartMin: r.preferredStart, // scenario-time proxy for the slot
        cargo: r.cargo,
      });
      if (rng() >= p) shown.add(r.id);
    }
    out.push(shown);
  }
  return out;
}

/**
 * Evaluate a plan on ONE realized scenario. Cost function identical to the
 * deterministic one, but loads/wait/maxLoad are recomputed on the shown
 * subset only. Reschedule/terminal terms are per-truck (fixed by the plan).
 */
export function evaluatePlanOnScenario(
  assignments: SlotAssignment[],
  requests: BookingRequest[],
  shown: Set<string>,
): ScenarioEvaluation {
  const byId = new Map(requests.map((r) => [r.id, r]));
  const loads: number[][] = GATE_IDS.map(() =>
    new Array<number>(SLOTS_PER_GATE).fill(0),
  );
  for (const a of assignments) {
    if (shown.has(a.requestId)) {
      loads[a.gate][startToSlotIndex(a.slotStart)] += 1;
    }
  }
  let maxLoad = 0;
  let overflowSlots = 0;
  for (const g of GATE_IDS) {
    for (let s = 0; s < SLOTS_PER_GATE; s++) {
      const l = loads[g][s];
      if (l > maxLoad) maxLoad = l;
      if (l > capacityForGate(g)) overflowSlots += 1;
    }
  }
  let separable = 0;
  let wait = 0;
  let shownTrucks = 0;
  for (const a of assignments) {
    if (!shown.has(a.requestId)) continue;
    shownTrucks += 1;
    const req = byId.get(a.requestId);
    if (a.rescheduled) separable += 3;
    // Terminal mismatch recomputed from the assignment's gate.
    if (req?.terminal && req.terminal !== 'any') {
      const expected =
        req.terminal === 'T1' ? 0 : req.terminal === 'T2' ? 1 : 2;
      if (expected !== a.gate) separable += 2;
    }
    const load = loads[a.gate][startToSlotIndex(a.slotStart)];
    wait += Math.max(0, ((load - 1) * serviceMinForGate(a.gate)) / 2);
  }
  const cost =
    maxLoad * DEFAULT_COST_WEIGHTS.peak +
    separable +
    wait * DEFAULT_COST_WEIGHTS.wait;
  return {
    cost,
    maxLoad,
    overflow: overflowSlots > 0,
    overflowSlots,
    shownTrucks,
  };
}

/** Recompute waitEstimateMin for every assignment from the plan's own loads. */
export function refreshAssignments(
  assignments: SlotAssignment[],
  requests: BookingRequest[],
): SlotAssignment[] {
  const loads: number[][] = GATE_IDS.map(() =>
    new Array<number>(SLOTS_PER_GATE).fill(0),
  );
  for (const a of assignments) {
    loads[a.gate][startToSlotIndex(a.slotStart)] += 1;
  }
  const byId = new Map(requests.map((r) => [r.id, r]));
  return assignments.map((a) => {
    const req = byId.get(a.requestId);
    const load = loads[a.gate][startToSlotIndex(a.slotStart)];
    return {
      ...a,
      waitEstimateMin: Math.max(
        0,
        ((load - 1) * serviceMinForGate(a.gate)) / 2,
      ),
      day: req?.day ?? a.day,
      terminal: terminalForGate(a.gate),
    };
  });
}

function evaluateCandidate(
  label: string,
  assignments: SlotAssignment[],
  requests: BookingRequest[],
  scenarios: Array<Set<string>>,
  alpha: number,
): CandidateEvaluation {
  const evals = scenarios.map((s) =>
    evaluatePlanOnScenario(assignments, requests, s),
  );
  const expectedCost =
    evals.reduce((sum, e) => sum + e.cost, 0) / Math.max(1, evals.length);
  const worstCost = Math.max(...evals.map((e) => e.cost), 0);
  const overflowProb =
    evals.filter((e) => e.overflow).length / Math.max(1, evals.length);
  return {
    label,
    assignments,
    expectedCost,
    worstCost,
    overflowProb,
    satisfiesChance: overflowProb <= alpha + 1e-9,
  };
}

/**
 * SAA stochastic plan: candidate-set search + chance constraint.
 * The deterministic plan is always a candidate, so the chosen plan's
 * expected cost is NEVER worse than deterministic on the sampled scenarios.
 */
export function stochasticPlan(
  requests: BookingRequest[],
  opts: StochasticOptions = {},
): StochasticResult {
  const k = Math.max(1, Math.min(200, Math.trunc(opts.scenarios ?? 25)));
  const seed = opts.seed ?? 42;
  const alpha = opts.alpha ?? 0.05;
  const method = opts.method ?? 'greedy';
  const scenarios = generateNoShowScenarios(requests, k, seed);

  const candidates: CandidateEvaluation[] = [];

  // Candidate 0: deterministic plan on full booked demand.
  const det = optimizeSlots(requests, { seed, method, overbook: false });
  candidates.push(
    evaluateCandidate('deterministic (full demand)', det, requests, scenarios, alpha),
  );

  // Candidates 1..K: optimize on scenario k's realized demand, then complete
  // the plan for absent trucks with the scenario plan as blocked capacity.
  for (let s = 0; s < k; s++) {
    const shown = scenarios[s];
    const shownReqs = requests.filter((r) => shown.has(r.id));
    if (shownReqs.length === 0) continue;
    const sub = optimizeSlots(shownReqs, { seed: seed + s, method, overbook: false });
    const missing = requests.filter((r) => !shown.has(r.id));
    let full: SlotAssignment[];
    if (missing.length === 0) {
      full = sub;
    } else {
      const completion = optimizeSlots(missing, {
        seed: seed + s + 1000,
        method,
        overbook: false,
        blocked: sub.map((a) => ({ gate: a.gate as GateId, slotStart: a.slotStart })),
      });
      full = refreshAssignments([...sub, ...completion], requests);
    }
    candidates.push(
      evaluateCandidate(`scenario ${s + 1} plan`, full, requests, scenarios, alpha),
    );
  }

  const deterministic = candidates[0];
  const feasible = candidates.filter((c) => c.satisfiesChance);
  const pool = feasible.length > 0 ? feasible : candidates;
  // Among the pool: lowest expected cost; tie-break: lowest worst-case cost.
  const chosen = [...pool].sort(
    (a, b) => a.expectedCost - b.expectedCost || a.worstCost - b.worstCost,
  )[0];

  return {
    scenarios: k,
    alpha,
    seed,
    deterministic,
    chosen,
    chanceSatisfied: chosen.satisfiesChance,
    expectedImprovement: Math.max(
      0,
      deterministic.expectedCost - chosen.expectedCost,
    ),
    candidates,
  };
}
