/**
 * lib/exact.ts
 *
 * Branch-and-bound EXACT optimizer for small TAS instances (n ≤ 12).
 *
 * This is the "professor move": heuristics are measured against PROVEN
 * optima, not against each other. The solver proves optimality by exhaustive
 * search with a valid lower bound — every pruned branch is mathematically
 * incapable of beating the incumbent.
 *
 * Cost function: EXACTLY the shared cost function of lib/optimizer.ts
 * (default weights: 10·peak + 3·rescheduled + 2·mismatch + 0.5·wait), where
 * the wait term is decomposed per (gate, slot) as L·(L−1)·τ_g/2 — the closed
 * form of the in-slot queue (see lib/formulation.ts). The solver therefore
 * scores plans identically to scorePlan; tests assert that equivalence.
 *
 * Lower bound (valid — every term is monotone in added trucks):
 *   LB = 10·maxLoadSoFar
 *      + Σ_placed (3·resched + 2·mismatch)
 *      + Σ_slots partialSlotWait(L)      [partial loads only grow]
 *      + Σ_unplaced minPerTruckTerm      [cheapest possible resched+mismatch]
 * Partial slot wait L·(L−1)·τ/2·0.5 only grows as trucks are added, the
 * peak only grows, and placed per-truck terms are final — so LB ≤ any
 * completion of the partial assignment. A branch with LB ≥ incumbent cost
 * cannot improve the incumbent and is pruned.
 *
 * Safety: a node budget (default 1,000,000). If it is exhausted the solver
 * returns the best solution found with optimal=false — it NEVER claims a
 * proof it did not complete. Complexity is worst-case O((G·S)^n); in
 * practice the bound prunes aggressively for n ≤ 12 on realistic demand.
 *
 * Scope: single-day demand, no overbooking by default (capacity = base
 * per-gate capacity). Blocked (frozen) loads and earliestSlotStart are
 * supported so replanning can use the exact solver on the remaining day.
 *
 * Blocked-load cost accounting (known nuance): the branch-and-bound search
 * optimizes the blocked-INCLUSIVE cost (frozen loads contribute to peak and
 * wait terms — the correct objective for search). The reported `cost` is
 * identical to scorePlan whenever `blocked` is empty (the case for every
 * current caller). With non-empty `blocked`, the "incumbent is optimal"
 * return path reports the blocked-exclusive scorePlan cost while a newly
 * found optimum reports the blocked-inclusive cost — the two paths can
 * differ by the constant frozen-load offset. Search correctness and the
 * feasibility guarantee are unaffected; only cross-path cost comparison
 * with blocked loads needs the offset in mind.
 */

import type {
  BookingRequest,
  SlotAssignment,
  GateId,
  TerminalId,
} from './types';
import {
  GATE_IDS,
  SLOTS_PER_GATE,
  slotIndexToStart,
  startToSlotIndex,
  slotIndexAtOrAfter,
  capacityForGate,
  serviceMinForGate,
  terminalForGate,
  gateForTerminal,
} from './types';
import { noShowProbability, overbookLimit } from './predictor';
import { optimizeSlots, scorePlan, DEFAULT_COST_WEIGHTS } from './optimizer';

export const EXACT_MAX_TRUCKS = 12;
export const DEFAULT_EXACT_MAX_NODES = 1_000_000;

export interface ExactOptions {
  seed?: number;
  /** Inflate per-slot capacity using the no-show-aware overbooking limit. */
  overbook?: boolean;
  /** Pre-occupied slots (frozen assignments). Count toward load/capacity/wait. */
  blocked?: Array<{ gate: GateId; slotStart: number }>;
  /** Earliest slot start (minutes since midnight) the solver may use. */
  earliestSlotStart?: number;
  /** Node budget; exhaustion returns best-so-far with optimal=false. */
  maxNodes?: number;
}

export interface ExactResult {
  assignments: SlotAssignment[];
  /** Cost on the shared cost function (default weights). */
  cost: number;
  /** True only if the search completed and the optimum is PROVEN. */
  optimal: boolean;
  /** Branch-and-bound nodes explored. */
  nodes: number;
  /** Branches pruned by the lower bound. */
  pruned: number;
  /** True if the node budget was exhausted before proving optimality. */
  aborted: boolean;
  /** Cost of the greedy incumbent the search started from. */
  incumbentCost: number;
  /** Feasible at all (false only under pathological blocked/minSlot input). */
  feasible: boolean;
}

function emptyLoads(): number[][] {
  return GATE_IDS.map(() => new Array<number>(SLOTS_PER_GATE).fill(0));
}

/** Reschedule flag, identical rule to optimizer.ts assignmentOf. */
function isRescheduled(req: BookingRequest, slotStart: number): boolean {
  return !(
    slotStart >= req.preferredStart - 15 && slotStart <= req.preferredEnd
  );
}

/** Per-truck separable cost terms for a candidate (gate, slot). */
function separableTerms(req: BookingRequest, gate: GateId, slotStart: number): number {
  let t = 0;
  if (isRescheduled(req, slotStart)) t += 3;
  if (req.terminal && req.terminal !== 'any') {
    if (gateForTerminal(req.terminal as TerminalId) !== gate) t += 2;
  }
  return t;
}

export function exactOptimize(
  requests: BookingRequest[],
  opts: ExactOptions = {},
): ExactResult {
  if (!requests || requests.length === 0) {
    return {
      assignments: [],
      cost: 0,
      optimal: true,
      nodes: 0,
      pruned: 0,
      aborted: false,
      incumbentCost: 0,
      feasible: true,
    };
  }
  if (requests.length > EXACT_MAX_TRUCKS) {
    throw new Error(
      `Exact solver capped at ${EXACT_MAX_TRUCKS} trucks (got ${requests.length}); use greedy/annealing for larger instances.`,
    );
  }
  const maxNodes = opts.maxNodes ?? DEFAULT_EXACT_MAX_NODES;

  // Capacity (same rule as optimizer.ts).
  let overbookFactor = 1;
  if (opts.overbook) {
    const avg =
      requests.reduce(
        (s, r) =>
          s +
          noShowProbability({
            leadTimeHours: r.leadTimeHours,
            driverNoShowRate: r.driverNoShowRate,
            slotStartMin: r.preferredStart,
            cargo: r.cargo,
          }),
        0,
      ) / requests.length;
    overbookFactor = overbookLimit(1, avg);
  }
  const capOf = (g: GateId): number => {
    const base = capacityForGate(g);
    if (overbookFactor <= 1) return base;
    return Math.min(Math.ceil(base * overbookFactor), base * 2);
  };

  // Blocked (frozen) loads count from the start.
  const blockedLoads = emptyLoads();
  for (const b of opts.blocked ?? []) {
    blockedLoads[b.gate][startToSlotIndex(b.slotStart)] += 1;
  }
  const minSlot =
    opts.earliestSlotStart !== undefined
      ? slotIndexAtOrAfter(opts.earliestSlotStart)
      : 0;

  // Fixed truck order (same as greedy: preferred start, then id).
  const order = [...requests].sort(
    (a, b) => a.preferredStart - b.preferredStart || (a.id < b.id ? -1 : 1),
  );

  // Precompute each truck's cheapest possible separable term (valid LB part).
  const minTerm = order.map((req) => {
    let best = Infinity;
    for (let s = minSlot; s < SLOTS_PER_GATE; s++) {
      const slotStart = slotIndexToStart(s);
      for (const g of GATE_IDS) {
        const t = separableTerms(req, g, slotStart);
        if (t < best) best = t;
      }
    }
    return Number.isFinite(best) ? best : 0;
  });
  // Suffix sums of min terms for fast LB computation.
  const suffixMin: number[] = new Array(order.length + 1).fill(0);
  for (let i = order.length - 1; i >= 0; i--) {
    suffixMin[i] = suffixMin[i + 1] + minTerm[i];
  }

  // Greedy incumbent (same options, default method). If the greedy plan
  // violates capacity (its overflow fallback — e.g. adversarial blocked
  // input filling every slot), it is NOT a valid incumbent.
  const incumbent = optimizeSlots(requests, {
    seed: opts.seed ?? 7,
    overbook: opts.overbook,
    blocked: opts.blocked,
    earliestSlotStart: opts.earliestSlotStart,
  });
  const incumbentLoads = blockedLoads.map((row) => [...row]);
  for (const a of incumbent) {
    incumbentLoads[a.gate][startToSlotIndex(a.slotStart)] += 1;
  }
  // NOTE: blocked (frozen) loads MUST be included here. The greedy plan is
  // only a valid incumbent when it respects capacity *on top of* the frozen
  // loads; checking the fresh assignments alone wrongly certified an
  // infeasible incumbent as a proven optimum on a fully-blocked day
  // (regression test: tests/exact-hardening.test.ts).
  let incumbentFeasible = true;
  for (const g of GATE_IDS) {
    for (let s = 0; s < SLOTS_PER_GATE; s++) {
      if (incumbentLoads[g][s] > capOf(g)) incumbentFeasible = false;
    }
  }
  const incumbentCost = incumbentFeasible
    ? scorePlan(incumbent, requests).cost
    : Infinity;

  // Candidate (gate, slot) lists per truck, ordered by incremental cost
  // (cheapest first) so good solutions are found early and pruning bites.
  // Incremental cost here = separable terms + marginal slot-wait increase
  // at the CURRENT (empty) load — a static ordering heuristic only.
  const candidates: Array<Array<{ g: GateId; s: number; key: number }>> =
    order.map((req) => {
      const list: Array<{ g: GateId; s: number; key: number }> = [];
      for (let s = minSlot; s < SLOTS_PER_GATE; s++) {
        const slotStart = slotIndexToStart(s);
        for (const g of GATE_IDS) {
          // Skip slots already full from blocked loads.
          if (blockedLoads[g][s] >= capOf(g)) continue;
          list.push({ g, s, key: separableTerms(req, g, slotStart) });
        }
      }
      list.sort((a, b) => a.key - b.key || a.g - b.g || a.s - b.s);
      return list;
    });

  let bestCost = incumbentCost;
  let bestChoice: Array<{ g: GateId; s: number }> | null = null;
  let nodes = 0;
  let pruned = 0;
  let aborted = false;

  const loads = blockedLoads.map((row) => [...row]);
  const choice: Array<{ g: GateId; s: number }> = new Array(order.length);

  // Partial slot-wait cost from current loads (only grows as trucks arrive).
  const partialSlotWait = (): number => {
    let sum = 0;
    for (const g of GATE_IDS) {
      const tau = serviceMinForGate(g);
      for (let s = 0; s < SLOTS_PER_GATE; s++) {
        const L = loads[g][s];
        if (L > 1) sum += (L * (L - 1) * tau) / 2;
      }
    }
    return sum * DEFAULT_COST_WEIGHTS.wait;
  };
  const partialMaxLoad = (): number => {
    let m = 0;
    for (const g of GATE_IDS) {
      for (let s = 0; s < SLOTS_PER_GATE; s++) {
        if (loads[g][s] > m) m = loads[g][s];
      }
    }
    return m;
  };

  const dfs = (i: number, placedSeparable: number): void => {
    if (aborted) return;
    nodes += 1;
    if (nodes > maxNodes) {
      aborted = true;
      return;
    }
    if (i === order.length) {
      const total =
        partialMaxLoad() * DEFAULT_COST_WEIGHTS.peak +
        placedSeparable +
        partialSlotWait();
      if (total < bestCost - 1e-9) {
        bestCost = total;
        bestChoice = choice.map((c) => ({ ...c }));
      }
      return;
    }
    // Lower bound for any completion of this partial assignment.
    const lb =
      partialMaxLoad() * DEFAULT_COST_WEIGHTS.peak +
      placedSeparable +
      partialSlotWait() +
      suffixMin[i];
    if (lb >= bestCost - 1e-9) {
      pruned += 1;
      return;
    }
    const req = order[i];
    for (const cand of candidates[i]) {
      if (loads[cand.g][cand.s] >= capOf(cand.g)) continue;
      loads[cand.g][cand.s] += 1;
      choice[i] = { g: cand.g, s: cand.s };
      dfs(i + 1, placedSeparable + cand.key);
      loads[cand.g][cand.s] -= 1;
      if (aborted) return;
    }
  };

  dfs(0, 0);

  if (bestChoice === null) {
    // No assignment beat the incumbent — the incumbent IS optimal.
    // (Greedy's cost is an upper bound; the search proved nothing better
    // exists, so the greedy plan is a proven optimum.) If the greedy
    // incumbent was infeasible, no feasible solution was found at all.
    if (!incumbentFeasible) {
      return {
        assignments: [],
        cost: Infinity,
        optimal: false,
        nodes,
        pruned,
        aborted,
        incumbentCost: Infinity,
        feasible: false,
      };
    }
    return {
      assignments: incumbent,
      cost: incumbentCost,
      optimal: !aborted,
      nodes,
      pruned,
      aborted,
      incumbentCost,
      feasible: true,
    };
  }

  // Rebuild SlotAssignment[] from the winning choices with final loads.
  // (bestChoice is non-null here — the null case returned above.)
  const winning = bestChoice as Array<{ g: GateId; s: number }>;
  const finalLoads = blockedLoads.map((row) => [...row]);
  for (let i = 0; i < order.length; i++) {
    finalLoads[winning[i].g][winning[i].s] += 1;
  }
  const assignments: SlotAssignment[] = order.map((req, i) => {
    const { g, s } = winning[i];
    const slotStart = slotIndexToStart(s);
    const load = finalLoads[g][s];
    return {
      requestId: req.id,
      gate: g,
      slotStart,
      rescheduled: isRescheduled(req, slotStart),
      noShowProbability: noShowProbability({
        leadTimeHours: req.leadTimeHours,
        driverNoShowRate: req.driverNoShowRate,
        slotStartMin: slotStart,
        cargo: req.cargo,
      }),
      waitEstimateMin: Math.max(0, ((load - 1) * serviceMinForGate(g)) / 2),
      day: req.day ?? 0,
      terminal: terminalForGate(g),
    };
  });

  return {
    assignments,
    cost: bestCost,
    optimal: !aborted,
    nodes,
    pruned,
    aborted,
    incumbentCost,
    feasible: true,
  };
}

/**
 * Compare exact optimum vs greedy vs annealing on the same small demand.
 * Returns the optimality gaps: gap = (heuristic − optimum) / optimum.
 * Gap 0 means the heuristic found a proven optimum on this instance.
 */
export function compareAgainstExact(
  requests: BookingRequest[],
  opts: ExactOptions = {},
): {
  exact: ExactResult;
  greedy: { cost: number; gapPct: number };
  annealed: { cost: number; gapPct: number };
} {
  const exact = exactOptimize(requests, opts);
  const greedy = optimizeSlots(requests, {
    seed: opts.seed ?? 7,
    overbook: opts.overbook,
    blocked: opts.blocked,
    earliestSlotStart: opts.earliestSlotStart,
    method: 'greedy',
  });
  const annealed = optimizeSlots(requests, {
    seed: opts.seed ?? 7,
    overbook: opts.overbook,
    blocked: opts.blocked,
    earliestSlotStart: opts.earliestSlotStart,
    method: 'annealed',
  });
  const gCost = scorePlan(greedy, requests).cost;
  const aCost = scorePlan(annealed, requests).cost;
  const gap = (c: number) =>
    exact.cost > 0 ? ((c - exact.cost) / exact.cost) * 100 : 0;
  return {
    exact,
    greedy: { cost: gCost, gapPct: gap(gCost) },
    annealed: { cost: aCost, gapPct: gap(aCost) },
  };
}
