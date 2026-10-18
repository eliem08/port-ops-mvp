import type { Berth, BerthPlan, ExactResult, PlanOptions, Vessel } from "./types";
import { generateTideWindows, needsTideWindow, nextTideWindowStart } from "./tide";
import { planNaive, sequencesToPlan } from "./berth";
import {
  CRANE_COST_USD_PER_HOUR,
  FUEL_BURN_T_PER_HOUR,
  OBJECTIVE_REFERENCE,
  cranesForVessel,
  normalizeWeights,
  planEconomics,
} from "./economics";
import { assertPlanningInputs } from "./validate";

/**
 * Exact solver for the discrete dynamic BAP: branch-and-bound over
 * per-berth sequences.
 *
 * Search: depth-first, appending one unplaced vessel at a time to the end
 * of one feasible berth's sequence. Append-only is the key property — once
 * a vessel is appended its start time never changes, so the partial cost
 * accumulated so far is a valid lower bound on any completion of the node.
 *
 * Duplicate paths are eliminated by a canonical-order rule: vessels are
 * appended in nondecreasing (start, vesselId) order. Every feasible plan
 * has exactly one append order satisfying this (sort its assignments by
 * start, ties by vessel id — per-berth sequences are start-ordered by the
 * sweep, so the predecessor on a berth is always appended first), so the
 * search visits each distinct plan once. Without this rule the same plan
 * would be reached via up to n! append permutations.
 *
 * Branching covers every (vessel, berth) pair, hence every feasible
 * sequence partition, including sequences that are NOT in ETA order (which
 * a naive ETA-ordered search would miss — e.g. a short job arriving just
 * after a long one can profitably jump the queue).
 *
 * Lower bound at a node: placed waiting + fuel + crane cost, plus for every
 * unplaced vessel the minimum possible additional waiting over its feasible
 * berths (max(0, berthAvailable − ETA), tide-adjusted), its fuel at that
 * waiting, and its cheapest feasible crane cost. The makespan epsilon term
 * is dropped from the bound (it is ≥ 0), so the bound stays admissible.
 *
 * The incumbent starts at the greedy plan. Search stops at the node cap
 * (then provenOptimal = false) or when the tree is exhausted (proven
 * optimal). Only vessels with ≥ 1 feasible berth enter the search; the
 * rest are unassigned in every plan. Practical limit: ≤ 8 vessels.
 *
 * Complexity is exponential — this is the price of proof. For the 10-vessel
 * demo set use the heuristics; the exact solver grades them on ≤ 8-vessel
 * subsets and benchmark instances.
 */

export const EXACT_MAX_VESSELS = 8;
const DEFAULT_NODE_CAP = 2_000_000;
const EPS = 1e-9;

interface ExactContext {
  vessels: Vessel[];
  berths: Berth[];
  opts: PlanOptions;
  tideWindows: ReturnType<typeof generateTideWindows>;
  weights: { waiting: number; fuel: number; crane: number };
  /** berthId -> vessels appended so far, in sequence order. */
  seqs: Map<string, string[]>;
  /** berthId -> time the berth becomes free. */
  avail: Map<string, number>;
  placed: Set<string>;
  placedWaiting: number;
  placedFuel: number;
  placedCraneCost: number;
  bestCost: number;
  bestSeqs: Map<string, string[]> | null;
  nodes: number;
  nodeCap: number;
  prune: boolean;
  /** Canonical-order key of the last appended vessel: (start, vesselId). */
  lastStart: number;
  lastVesselId: string;
}

function tideStart(vessel: Vessel, rawStart: number, ctx: ExactContext): number {
  if (ctx.opts.tidesEnabled && needsTideWindow(vessel)) {
    return nextTideWindowStart(rawStart, ctx.tideWindows);
  }
  return rawStart;
}

/** Admissible lower bound on the weighted objective for the current node. */
function lowerBound(ctx: ExactContext): number {
  let minExtraWaiting = 0;
  let minExtraFuel = 0;
  let minExtraCraneCost = 0;

  for (const vessel of ctx.vessels) {
    if (ctx.placed.has(vessel.id)) continue;
    let bestWait = Infinity;
    let bestCrane = Infinity;
    for (const berth of ctx.berths) {
      if (vessel.lengthM > berth.lengthM) continue;
      if (vessel.cargo === "grain" && !berth.grainCapable) continue;
      const avail = ctx.avail.get(berth.id) ?? 0;
      const start = tideStart(vessel, Math.max(vessel.etaHours, avail), ctx);
      bestWait = Math.min(bestWait, Math.max(0, start - vessel.etaHours));
      const craneCost =
        cranesForVessel(vessel, berth) * vessel.handlingHours * CRANE_COST_USD_PER_HOUR;
      bestCrane = Math.min(bestCrane, craneCost);
    }
    if (!Number.isFinite(bestWait)) continue; // unassignable in every plan
    minExtraWaiting += bestWait;
    minExtraFuel += bestWait * (FUEL_BURN_T_PER_HOUR[vessel.cargo] ?? 0.9);
    minExtraCraneCost += Number.isFinite(bestCrane) ? bestCrane : 0;
  }

  const w = ctx.weights;
  return (
    w.waiting * ((ctx.placedWaiting + minExtraWaiting) / OBJECTIVE_REFERENCE.waitingHours) +
    w.fuel * ((ctx.placedFuel + minExtraFuel) / OBJECTIVE_REFERENCE.fuelTonnes) +
    w.crane * ((ctx.placedCraneCost + minExtraCraneCost) / OBJECTIVE_REFERENCE.craneCostUsd)
  );
}

function dfs(ctx: ExactContext): boolean {
  ctx.nodes++;
  if (ctx.nodes > ctx.nodeCap) return false; // cap hit: stop, not proven

  if (ctx.placed.size === ctx.vessels.length) {
    // Complete solution: evaluate exactly (incl. makespan epsilon term).
    const plan = sequencesToPlan(ctx.seqs, ctx.vessels, {
      tidesEnabled: ctx.opts.tidesEnabled ?? false,
    });
    const cost = planEconomics(plan, ctx.vessels, ctx.berths, ctx.opts.weights).objective;
    if (cost < ctx.bestCost - EPS) {
      ctx.bestCost = cost;
      ctx.bestSeqs = new Map(
        [...ctx.seqs.entries()].map(([k, v]) => [k, v.slice()]),
      );
    }
    return true;
  }

  if (ctx.prune && lowerBound(ctx) >= ctx.bestCost - EPS) return true;

  // Branch over every (unplaced vessel, feasible berth) pair, subject to
  // the canonical-order rule: (start, vesselId) must be >= the last
  // appended vessel's key, so each distinct plan is visited exactly once.
  // Candidates are tried in (start, vesselId, berthId) order so good
  // solutions (strong incumbents) are found early and prune hard.
  const candidates: Array<{ vessel: Vessel; berth: Berth; start: number }> = [];
  for (const vessel of ctx.vessels) {
    if (ctx.placed.has(vessel.id)) continue;
    for (const berth of ctx.berths) {
      if (vessel.lengthM > berth.lengthM) continue;
      if (vessel.cargo === "grain" && !berth.grainCapable) continue;
      const avail = ctx.avail.get(berth.id) ?? 0;
      const start = tideStart(vessel, Math.max(vessel.etaHours, avail), ctx);
      if (
        start < ctx.lastStart - EPS ||
        (Math.abs(start - ctx.lastStart) <= EPS && vessel.id < ctx.lastVesselId)
      ) {
        continue;
      }
      candidates.push({ vessel, berth, start });
    }
  }
  candidates.sort(
    (a, b) =>
      a.start - b.start ||
      (a.vessel.id < b.vessel.id ? -1 : a.vessel.id > b.vessel.id ? 1 : 0) ||
      (a.berth.id < b.berth.id ? -1 : a.berth.id > b.berth.id ? 1 : 0),
  );

  for (const { vessel, berth, start } of candidates) {
    const waiting = Math.max(0, start - vessel.etaHours);
    const fuel = waiting * (FUEL_BURN_T_PER_HOUR[vessel.cargo] ?? 0.9);
    const craneCost =
      cranesForVessel(vessel, berth) * vessel.handlingHours * CRANE_COST_USD_PER_HOUR;

    const prevAvail = ctx.avail.get(berth.id) ?? 0;
    const prevLastStart = ctx.lastStart;
    const prevLastVesselId = ctx.lastVesselId;
    ctx.seqs.get(berth.id)?.push(vessel.id);
    ctx.avail.set(berth.id, start + vessel.handlingHours);
    ctx.placed.add(vessel.id);
    ctx.placedWaiting += waiting;
    ctx.placedFuel += fuel;
    ctx.placedCraneCost += craneCost;
    ctx.lastStart = start;
    ctx.lastVesselId = vessel.id;

    const ok = dfs(ctx);

    ctx.lastVesselId = prevLastVesselId;
    ctx.lastStart = prevLastStart;
    ctx.placedCraneCost -= craneCost;
    ctx.placedFuel -= fuel;
    ctx.placedWaiting -= waiting;
    ctx.placed.delete(vessel.id);
    ctx.avail.set(berth.id, prevAvail);
    ctx.seqs.get(berth.id)?.pop();

    if (!ok) return false;
  }
  return true;
}

/**
 * Solve the BAP exactly by branch-and-bound. Vessels beyond
 * EXACT_MAX_VESSELS are rejected — the tree is exponential and the solver
 * must not be pointed at instances it cannot prove.
 */
export function solveExact(
  vessels: Vessel[],
  berths: Berth[],
  opts: PlanOptions = {},
  nodeCap: number = DEFAULT_NODE_CAP,
  prune: boolean = true,
): ExactResult {
  assertPlanningInputs(vessels, berths);
  const searchable = vessels.filter((v) =>
    berths.some(
      (b) => v.lengthM <= b.lengthM && !(v.cargo === "grain" && !b.grainCapable),
    ),
  );
  if (searchable.length > EXACT_MAX_VESSELS) {
    throw new Error(
      `exact solver limited to ${EXACT_MAX_VESSELS} vessels (received ${searchable.length}); use the heuristics for larger instances`,
    );
  }

  const horizon =
    Math.max(0, ...searchable.map((v) => v.etaHours)) +
    searchable.reduce((s, v) => s + v.handlingHours, 0) +
    48;
  const tideWindows = generateTideWindows(horizon);

  // Incumbent: greedy plan.
  const greedyPlan = planNaive(searchable, berths, opts);
  const incumbentCost = planEconomics(greedyPlan, searchable, berths, opts.weights).objective;

  const seqs = new Map<string, string[]>();
  const avail = new Map<string, number>();
  for (const berth of berths) {
    seqs.set(berth.id, []);
    avail.set(berth.id, 0);
  }

  const ctx: ExactContext = {
    vessels: searchable,
    berths,
    opts,
    tideWindows,
    weights: normalizeWeights(opts.weights ?? { waiting: 1, fuel: 0, crane: 0 }),
    seqs,
    avail,
    placed: new Set(),
    placedWaiting: 0,
    placedFuel: 0,
    placedCraneCost: 0,
    bestCost: incumbentCost,
    bestSeqs: null,
    nodes: 0,
    nodeCap,
    prune,
    lastStart: Number.NEGATIVE_INFINITY,
    lastVesselId: "",
  };

  const completed = dfs(ctx);
  const provenOptimal = completed && ctx.nodes <= nodeCap;

  // If B&B never beat greedy, the greedy sequences are the best found.
  let plan: BerthPlan;
  if (ctx.bestSeqs) {
    plan = sequencesToPlan(ctx.bestSeqs, vessels, {
      tidesEnabled: opts.tidesEnabled ?? false,
    });
  } else {
    plan = planNaive(vessels, berths, opts);
  }
  const objective = planEconomics(plan, vessels, berths, opts.weights).objective;

  return {
    plan,
    objective,
    provenOptimal,
    nodesExplored: ctx.nodes,
    vesselCount: searchable.length,
    gaps: [],
  };
}

/**
 * Grade heuristic plans against the exact optimum: gap % = (heuristic −
 * optimum) / optimum × 100. A gap of 0 means the heuristic found the
 * optimum; a negative gap is impossible and indicates a bug.
 */
export function gapAgainstExact(
  heuristicObjective: number,
  exactObjective: number,
): number | null {
  if (!Number.isFinite(exactObjective) || exactObjective <= 0) return null;
  return ((heuristicObjective - exactObjective) / exactObjective) * 100;
}
