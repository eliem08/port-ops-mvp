/**
 * lib/optimizer.ts
 *
 * Slot-allocation optimizer for the truck appointment system.
 *
 * Three strategies, all deterministic given a seed:
 *   - optimizeSlots (method 'greedy'): greedy assignment (preferred window
 *     first, least-loaded gate/slot) followed by a short local-search
 *     improvement phase that minimizes peak slot load, reschedules, and
 *     waiting time.
 *   - optimizeSlots (method 'annealed'): greedy + local search, then
 *     simulated annealing (lib/annealer.ts) over single-truck reassignments.
 *     The best-seen solution is kept, so annealing can never do worse than
 *     greedy on the shared cost function.
 *   - baselineAssign: first-come-first-served — each truck takes the earliest
 *     feasible slot at its cargo's default gate, ignoring load balancing.
 *     This reproduces the "status quo" congestion for comparison.
 *
 * Per-gate service model: gates have different service times and therefore
 * different per-slot capacities (express 7, standard 6, inspection 3).
 * Terminal preference: a booking naming a terminal pays a penalty when placed
 * at another terminal's gate.
 *
 * Pure functions — no I/O, no framework.
 */

import type {
  BookingRequest,
  SlotAssignment,
  GateId,
  HorizonPlan,
  OptimizerMethod,
  TerminalId,
} from './types';
import {
  GATES,
  GATE_IDS,
  SLOT_MINUTES,
  DAY_START_MIN,
  DAY_END_MIN,
  SLOTS_PER_GATE,
  HORIZON_DAYS,
  slotIndexToStart,
  startToSlotIndex,
  slotIndexAtOrAfter,
  capacityForGate,
  serviceMinForGate,
  terminalForGate,
  gateForTerminal,
} from './types';
import { makeRng } from './data';
import { noShowProbability, overbookLimit } from './predictor';
import { simulatedAnneal } from './annealer';

/** Penalty added when a candidate slot falls outside the preferred window. */
const RESCHEDULE_PENALTY = 6;

/** Penalty added when a candidate gate is not the booking's terminal gate. */
const TERMINAL_MISMATCH_PENALTY = 4;

/** Local-search iterations. */
const LOCAL_SEARCH_ITERATIONS = 250;

/** Annealing moves (kept small so the demo stays interactive). */
const ANNEAL_ITERATIONS = 2500;

/** Objective weights for the shared cost function. Pareto sweeps override them. */
export interface CostWeights {
  /** Weight on peak slot load (max over all gate/slots). */
  peak: number;
  /** Weight per rescheduled truck (assigned outside its preferred window). */
  reschedule: number;
  /** Weight per terminal mismatch (truck placed at another terminal's gate). */
  terminal: number;
  /** Weight per minute of modelled wait. */
  wait: number;
}

/** Default weights: the cost function documented in the README. */
export const DEFAULT_COST_WEIGHTS: CostWeights = {
  peak: 10,
  reschedule: 3,
  terminal: 2,
  wait: 0.5,
};

function resolveWeights(w?: Partial<CostWeights>): CostWeights {
  return { ...DEFAULT_COST_WEIGHTS, ...(w ?? {}) };
}

export interface OptimizeOptions {
  seed?: number;
  /** Inflate per-slot capacity using the no-show-aware overbooking limit. */
  overbook?: boolean;
  /** Optimization strategy: greedy+local-search (default) or + annealing. */
  method?: OptimizerMethod;
  /**
   * Pre-occupied slots (frozen assignments from replanning). Each entry
   * counts toward that gate/slot's load and capacity; the optimizer never
   * moves them and never double-books past capacity because of them.
   */
  blocked?: Array<{ gate: GateId; slotStart: number }>;
  /**
   * Earliest slot start (minutes since midnight) the optimizer may use.
   * Replanning sets this to "now" so no truck is placed in the past.
   */
  earliestSlotStart?: number;
  /**
   * Objective weights (Pareto sweeps override them). Defaults reproduce the
   * documented cost function: 10·peak + 3·rescheduled + 2·mismatch + 0.5·wait.
   */
  weights?: Partial<CostWeights>;
}

/** Default gate per cargo family (matches TERMINAL_BY_GATE in data.ts). */
const DEFAULT_GATE: Record<string, GateId> = {
  general: 0,
  grain: 1,
  reefer: 2,
  hazmat: 0,
};

/** Number of slots in the operating day. */
export function slotsPerDay(): number {
  return SLOTS_PER_GATE;
}

/** Clamp an absolute minute into a valid slot index. */
export function slotIndexFor(min: number): number {
  return startToSlotIndex(min);
}

/** Current load keyed by `${gate}:${slotStart}` — handy for tests and UI. */
export function loadBySlot(assignments: SlotAssignment[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of assignments) {
    const k = `${a.gate}:${a.slotStart}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function featuresFor(r: BookingRequest, slotStart: number) {
  return {
    leadTimeHours: r.leadTimeHours,
    driverNoShowRate: r.driverNoShowRate,
    slotStartMin: slotStart,
    cargo: r.cargo,
  };
}

interface Placed {
  req: BookingRequest;
  gate: GateId;
  slot: number; // slot index
}

function emptyLoads(): number[][] {
  return GATE_IDS.map(() => new Array<number>(SLOTS_PER_GATE).fill(0));
}

function assignmentOf(p: Placed, loads: number[][]): SlotAssignment {
  const slotStart = slotIndexToStart(p.slot);
  const inWindow =
    slotStart >= p.req.preferredStart - SLOT_MINUTES / 2 &&
    slotStart <= p.req.preferredEnd;
  const load = loads[p.gate][p.slot];
  return {
    requestId: p.req.id,
    gate: p.gate,
    slotStart,
    rescheduled: !inWindow,
    noShowProbability: noShowProbability(featuresFor(p.req, slotStart)),
    // Expected queue wait: half the trucks ahead of you × this gate's service time.
    waitEstimateMin: Math.max(0, ((load - 1) * serviceMinForGate(p.gate)) / 2),
    day: p.req.day ?? 0,
    terminal: terminalForGate(p.gate),
  };
}

/**
 * Shared cost function: peak slot load dominates, then reschedules, then
 * waiting time, then terminal mismatches. Greedy local search, annealing,
 * and scorePlan all use this — so comparisons between methods are fair.
 * Weights default to the documented cost function; Pareto sweeps override.
 */
function totalCost(placed: Placed[], loads: number[][], w: CostWeights): number {
  let maxLoad = 0;
  let rescheduled = 0;
  let terminalMismatch = 0;
  let wait = 0;
  for (const p of placed) {
    const a = assignmentOf(p, loads);
    if (a.rescheduled) rescheduled += 1;
    wait += a.waitEstimateMin;
    const l = loads[p.gate][p.slot];
    if (l > maxLoad) maxLoad = l;
    if (p.req.terminal && p.req.terminal !== 'any') {
      if (gateForTerminal(p.req.terminal) !== p.gate) terminalMismatch += 1;
    }
  }
  return (
    maxLoad * w.peak +
    rescheduled * w.reschedule +
    terminalMismatch * w.terminal +
    wait * w.wait
  );
}

function rebuildLoads(placed: Placed[], base?: number[][]): number[][] {
  const loads = base ? base.map((row) => [...row]) : emptyLoads();
  for (const p of placed) loads[p.gate][p.slot] += 1;
  return loads;
}

/** Capacity for a gate/slot, optionally inflated by overbooking. */
export function slotCapacity(gate: GateId, overbookFactor: number): number {
  const base = capacityForGate(gate);
  if (overbookFactor <= 1) return base;
  return Math.min(Math.ceil(base * overbookFactor), base * 2);
}

/**
 * The no-show-aware overbooking factor for a demand set: ceil(1 / show-up
 * rate) capped at 2x. Extracted so the API layer can report overloads
 * against the same inflated capacity the optimizer used.
 */
export function overbookFactorFor(requests: BookingRequest[]): number {
  if (requests.length === 0) return 1;
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
  return overbookLimit(1, avg); // 1 -> inflated unit factor
}

export interface SlotOverload {
  gate: GateId;
  slotStart: number;
  load: number;
  capacity: number;
}

/**
 * Slots where a finished plan exceeds (possibly overbook-inflated)
 * capacity. Empty under normal demand; non-empty exactly when the
 * optimizer's extreme-overload fallback spilled trucks onto full slots
 * rather than dropping them. The /api/optimize summary surfaces the count
 * so overloads are visible instead of silent.
 */
export function findOverloads(
  assignments: SlotAssignment[],
  overbookFactor = 1,
): SlotOverload[] {
  const loads = new Map<string, { gate: GateId; slotStart: number; load: number }>();
  for (const a of assignments) {
    const k = `${a.gate}:${a.slotStart}`;
    const e = loads.get(k);
    if (e) e.load += 1;
    else loads.set(k, { gate: a.gate, slotStart: a.slotStart, load: 1 });
  }
  const out: SlotOverload[] = [];
  for (const e of loads.values()) {
    const capacity = slotCapacity(e.gate, overbookFactor);
    if (e.load > capacity) out.push({ ...e, capacity });
  }
  out.sort((a, b) => b.load - b.capacity - (a.load - a.capacity));
  return out;
}

/**
 * Greedy + local-search (+ optional annealing) slot assignment for ONE day.
 * Requests carrying a `day` field keep it on their assignments; the caller
 * is responsible for grouping multi-day demand (see optimizeHorizon).
 */
export function optimizeSlots(
  requests: BookingRequest[],
  opts: OptimizeOptions = {},
): SlotAssignment[] {
  if (!requests || requests.length === 0) return [];
  const rng = makeRng(opts.seed ?? 7);

  // Overbooking factor from expected no-shows (same for every gate).
  const overbookFactor = opts.overbook ? overbookFactorFor(requests) : 1;

  // Frozen (blocked) loads count toward capacity from the start.
  const blockedLoads = emptyLoads();
  for (const b of opts.blocked ?? []) {
    const s = startToSlotIndex(b.slotStart);
    blockedLoads[b.gate][s] += 1;
  }

  // No placement before this slot (replanning: never schedule in the past).
  const minSlot =
    opts.earliestSlotStart !== undefined
      ? slotIndexAtOrAfter(opts.earliestSlotStart)
      : 0;

  // Greedy order: earliest preferred start first (stable by id).
  const order = [...requests].sort(
    (a, b) => a.preferredStart - b.preferredStart || (a.id < b.id ? -1 : 1),
  );

  const loads: number[][] = blockedLoads.map((row) => [...row]);
  const placed: Placed[] = [];

  for (const req of order) {
    const ws = startToSlotIndex(req.preferredStart);
    const we = Math.max(ws, startToSlotIndex(req.preferredEnd));
    const terminalGate =
      req.terminal && req.terminal !== 'any'
        ? gateForTerminal(req.terminal as TerminalId)
        : null;
    let best: { g: GateId; s: number; cost: number } | null = null;

    for (let s = minSlot; s < SLOTS_PER_GATE; s++) {
      const inWindow = s >= ws && s <= we;
      const penalty = inWindow ? 0 : RESCHEDULE_PENALTY;
      for (const g of GATE_IDS) {
        const cap = slotCapacity(g, overbookFactor);
        if (loads[g][s] >= cap) continue;
        const termPenalty =
          terminalGate !== null && terminalGate !== g
            ? TERMINAL_MISMATCH_PENALTY
            : 0;
        const cost = loads[g][s] + penalty + termPenalty;
        if (
          best === null ||
          cost < best.cost - 1e-9 ||
          (Math.abs(cost - best.cost) <= 1e-9 &&
            (g < best.g || (g === best.g && s < best.s)))
        ) {
          best = { g, s, cost };
        }
      }
    }

    // Fallback: if every slot is at capacity (extreme overload), allow overflow
    // on the least-loaded slot inside the window (never before minSlot).
    if (!best) {
      let minLoad = Infinity;
      for (let s = Math.max(ws, minSlot); s <= we; s++) {
        for (const g of GATE_IDS) {
          if (loads[g][s] < minLoad) {
            minLoad = loads[g][s];
            best = { g, s, cost: minLoad + 0 };
          }
        }
      }
    }
    // Absolute fallback (should be unreachable): earliest usable slot, gate 0.
    const pick = best ?? { g: 0 as GateId, s: Math.max(ws, minSlot), cost: 0 };
    loads[pick.g][pick.s] += 1;
    placed.push({ req, gate: pick.g, slot: pick.s });
  }

  // Local search: random reassignments accepted only on strict improvement.
  const weights = resolveWeights(opts.weights);
  for (let it = 0; it < LOCAL_SEARCH_ITERATIONS; it++) {
    const i = Math.floor(rng() * placed.length);
    const p = placed[i];
    const before = totalCost(placed, loads, weights);

    const oldG = p.gate;
    const oldS = p.slot;
    loads[oldG][oldS] -= 1;

    const newG = GATE_IDS[Math.floor(rng() * GATE_IDS.length)];
    const newS = minSlot + Math.floor(rng() * (SLOTS_PER_GATE - minSlot));
    p.gate = newG;
    p.slot = newS;
    loads[newG][newS] += 1;

    const cap = slotCapacity(newG, overbookFactor);
    const after = totalCost(placed, loads, weights);
    if (!(after < before - 1e-9) || loads[newG][newS] > cap) {
      // revert: no improvement, or the move broke slot capacity
      loads[newG][newS] -= 1;
      p.gate = oldG;
      p.slot = oldS;
      loads[oldG][oldS] += 1;
    }
  }

  // Simulated annealing: random single-truck moves, uphill moves accepted
  // with probability exp(-Δ/T) under geometric cooling. Best-seen wins.
  if (opts.method === 'annealed' && placed.length > 0) {
    const capOf = (g: GateId) => slotCapacity(g, overbookFactor);
    const state = placed.map((p) => ({ ...p }));
    // Capacity violations get a steep penalty inside the SA cost so the
    // search steers away from infeasible states instead of discovering them
    // only at the final feasibility check.
    const costOf = (st: Placed[]) => {
      const l = rebuildLoads(st, blockedLoads);
      let violation = 0;
      for (const g of GATE_IDS) {
        for (let s = 0; s < SLOTS_PER_GATE; s++) {
          if (l[g][s] > capOf(g)) violation += l[g][s] - capOf(g);
        }
      }
      return totalCost(st, l, weights) + violation * 1000;
    };
    const { best } = simulatedAnneal({
      initial: state,
      clone: (s) => s.map((p) => ({ ...p })),
      cost: costOf,
      neighbor: (st, nrng) => {
        const i = Math.floor(nrng() * st.length);
        st[i].gate = GATE_IDS[Math.floor(nrng() * GATE_IDS.length)];
        st[i].slot = minSlot + Math.floor(nrng() * (SLOTS_PER_GATE - minSlot));
      },
      options: {
        iterations: ANNEAL_ITERATIONS,
        startTemp: 6,
        endTemp: 0.02,
        rng,
      },
    });
    // Accept the annealed placement only if it respects capacity everywhere;
    // the best-seen guarantee means it is never worse than greedy on cost.
    const annealedLoads = rebuildLoads(best, blockedLoads);
    let feasible = true;
    for (const g of GATE_IDS) {
      for (let s = 0; s < SLOTS_PER_GATE; s++) {
        if (annealedLoads[g][s] > capOf(g) + 1e-9) {
          feasible = false;
          break;
        }
      }
      if (!feasible) break;
    }
    if (feasible) {
      placed.splice(0, placed.length, ...best);
    }
  }

  const finalLoads = rebuildLoads(placed, blockedLoads);
  return placed.map((p) => assignmentOf(p, finalLoads));
}

/**
 * Score a finished plan on the shared cost function. Used by the benchmark
 * panel to compare methods on identical demand. Weights default to the
 * documented cost function; pass Pareto weights to score under them.
 */
export function scorePlan(
  assignments: SlotAssignment[],
  requests: BookingRequest[],
  weights?: Partial<CostWeights>,
): { cost: number; maxLoad: number; rescheduled: number; totalWait: number; avgWait: number } {
  const w = resolveWeights(weights);
  const byId = new Map(requests.map((r) => [r.id, r]));
  const loads = emptyLoads();
  for (const a of assignments) {
    loads[a.gate][startToSlotIndex(a.slotStart)] += 1;
  }
  let maxLoad = 0;
  let rescheduled = 0;
  let terminalMismatch = 0;
  let wait = 0;
  for (const a of assignments) {
    const req = byId.get(a.requestId);
    if (req?.terminal && req.terminal !== 'any') {
      if (gateForTerminal(req.terminal) !== a.gate) terminalMismatch += 1;
    }
    if (a.rescheduled) rescheduled += 1;
    wait += a.waitEstimateMin;
    const l = loads[a.gate][startToSlotIndex(a.slotStart)];
    if (l > maxLoad) maxLoad = l;
  }
  const cost =
    maxLoad * w.peak +
    rescheduled * w.reschedule +
    terminalMismatch * w.terminal +
    wait * w.wait;
  return {
    cost,
    maxLoad,
    rescheduled,
    totalWait: wait,
    avgWait: assignments.length > 0 ? wait / assignments.length : 0,
  };
}

/**
 * Optimize a whole rolling horizon: group requests by day, optimize each
 * day independently (days share no capacity — each day has its own slots),
 * and return one plan per day.
 */
export function optimizeHorizon(
  requests: BookingRequest[],
  opts: OptimizeOptions = {},
): HorizonPlan {
  const byDay = new Map<number, BookingRequest[]>();
  for (const r of requests) {
    const d = r.day ?? 0;
    const list = byDay.get(d) ?? [];
    list.push(r);
    byDay.set(d, list);
  }
  const days: HorizonPlan['days'] = [];
  const dayKeys = [...byDay.keys()].sort((a, b) => a - b);
  for (const d of dayKeys) {
    days.push({
      day: d,
      requests: byDay.get(d) ?? [],
      assignments: optimizeSlots(byDay.get(d) ?? [], {
        ...opts,
        seed: (opts.seed ?? 7) + d * 101,
      }),
    });
  }
  // Include empty days up to the horizon length so the UI can render them.
  const maxDay = Math.max(HORIZON_DAYS - 1, ...dayKeys);
  for (let d = 0; d <= maxDay; d += 1) {
    if (!byDay.has(d)) {
      days.push({ day: d, requests: [], assignments: [] });
    }
  }
  days.sort((a, b) => a.day - b.day);
  return { days, method: opts.method ?? 'greedy' };
}

/**
 * First-come-first-served baseline: earliest feasible slot at the cargo's
 * default gate, ignoring load balancing. Reproduces status-quo bunching.
 */
export function baselineAssign(requests: BookingRequest[]): SlotAssignment[] {
  if (!requests || requests.length === 0) return [];
  const order = [...requests].sort((a, b) => a.createdAt - b.createdAt);
  const loads: number[][] = GATE_IDS.map(() =>
    new Array<number>(SLOTS_PER_GATE).fill(0),
  );
  const out: SlotAssignment[] = [];

  for (const req of order) {
    const gate = DEFAULT_GATE[req.cargo] ?? 0;
    const ws = startToSlotIndex(req.preferredStart);
    const cap = capacityForGate(gate);
    // Earliest slot at this gate with spare capacity; else the emptiest slot.
    let slot = -1;
    for (let s = ws; s < SLOTS_PER_GATE; s++) {
      if (loads[gate][s] < cap) {
        slot = s;
        break;
      }
    }
    if (slot === -1) {
      let minLoad = Infinity;
      for (let s = 0; s < SLOTS_PER_GATE; s++) {
        if (loads[gate][s] < minLoad) {
          minLoad = loads[gate][s];
          slot = s;
        }
      }
    }
    loads[gate][slot] += 1;
    const slotStart = slotIndexToStart(slot);
    out.push({
      requestId: req.id,
      gate,
      slotStart,
      rescheduled: false, // baseline never "reschedules" — it just queues
      noShowProbability: 0, // unknown without a TAS
      waitEstimateMin: Math.max(
        0,
        ((loads[gate][slot] - 1) * serviceMinForGate(gate)) / 2,
      ),
      day: req.day ?? 0,
      terminal: terminalForGate(gate),
    });
  }
  return out;
}

export { GATES, SLOT_MINUTES, DAY_START_MIN, DAY_END_MIN };
