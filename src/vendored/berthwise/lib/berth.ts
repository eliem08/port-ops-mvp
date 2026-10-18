import type {
  AlgorithmId,
  AlgorithmResult,
  Assignment,
  Berth,
  BerthPlan,
  ComparisonResult,
  DragValidation,
  ObjectiveWeights,
  PlanOptions,
  TideWindow,
  Vessel,
} from "./types";
import { mulberry32 } from "./rng";
import { assertPlanningInputs } from "./validate";
import { generateTideWindows, isInTideWindow, needsTideWindow, nextTideWindowStart } from "./tide";
import { planEconomics, cranesForVessel, CRANE_POOL_LIMIT } from "./economics";
import { cranesFreeAt, scheduleCranes } from "./cranes";
import { planGA } from "./ga";
import { planALNS } from "./alns";

export type {
  AlgorithmId,
  AlgorithmResult,
  Assignment,
  Berth,
  BerthPlan,
  ComparisonResult,
  DragValidation,
  ObjectiveWeights,
  PlanOptions,
  TideWindow,
  Vessel,
} from "./types";

/** Simulated-annealing tuning constants. */
const SA_TEMP_START = 8;
const SA_TEMP_END = 0.02;
/** Iterations per millisecond of time budget — keeps runs deterministic. */
const ITERATIONS_PER_MS = 200;
const DEFAULT_SEED = 42;
const DEFAULT_TIME_LIMIT_MS = 500;
/** Tabu tenure: how many iterations a (vessel, berth) move stays forbidden. */
const TABU_TENURE = 12;
/** Candidate moves sampled per tabu iteration. */
const TABU_CANDIDATES_PER_ITERATION = 8;
const EPS = 1e-9;

/**
 * A vessel can only be moored at a berth that is long enough for it, and grain
 * vessels additionally require a grain-capable berth.
 */
export function berthFeasible(vessel: Vessel, berth: Berth): boolean {
  if (vessel.lengthM > berth.lengthM) return false;
  if (vessel.cargo === "grain" && !berth.grainCapable) return false;
  return true;
}

/** Deterministic lexicographic comparison used for all id tie-breaks. */
function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Deep-ish clone of the berth -> ordered vessel ids representation. */
function cloneSeqs(seqs: Map<string, string[]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [berthId, list] of seqs) out.set(berthId, list.slice());
  return out;
}

function tideHorizon(vessels: Vessel[]): number {
  return (
    Math.max(0, ...vessels.map((v) => v.etaHours)) +
    vessels.reduce((s, v) => s + v.handlingHours, 0) +
    48
  );
}

interface SweepOptions {
  tidesEnabled?: boolean;
  tideWindows?: TideWindow[];
  /** Per-vessel "not before" floors (used to honour drag-and-drop positions). */
  notBefore?: Map<string, number>;
}

/** Options accepted by the exported sequencesToPlan helper. */
export interface SequenceSweepOptions {
  tidesEnabled?: boolean;
  tideWindows?: TideWindow[];
  notBefore?: Map<string, number>;
}

/**
 * Sweeps each berth's ordered vessel sequence into concrete assignments.
 *
 * For every berth the vessels are processed in list order:
 *   start = max(vessel.etaHours, previousEnd)
 *   end   = start + vessel.handlingHours
 *
 * With tides enabled, deep-draft vessels additionally wait for the next
 * high-water window before starting. Because a berth is swept sequentially,
 * no two assignments on the same berth can ever overlap. Vessels that do
 * not appear in any sequence are reported as unassigned.
 */
function buildPlan(
  seqs: Map<string, string[]>,
  vessels: Map<string, Vessel>,
  opts: SweepOptions = {},
): BerthPlan {
  const tidesEnabled = opts.tidesEnabled ?? false;
  const vesselList = [...vessels.values()];
  const tideWindows = opts.tideWindows ?? generateTideWindows(tideHorizon(vesselList));

  const assignments: Assignment[] = [];
  const berthBusyHours: Record<string, number> = {};
  const placed = new Set<string>();

  let totalWaitingHours = 0;
  let makespanHours = 0;

  for (const [berthId, sequence] of seqs) {
    let busyHours = 0;
    let previousEnd = 0;

    for (const vesselId of sequence) {
      const vessel = vessels.get(vesselId);
      if (!vessel) continue;

      let startHours = Math.max(vessel.etaHours, previousEnd);
      const floor = opts.notBefore?.get(vesselId);
      if (floor !== undefined) startHours = Math.max(startHours, floor);
      if (tidesEnabled && needsTideWindow(vessel)) {
        startHours = nextTideWindowStart(startHours, tideWindows);
      }
      const endHours = startHours + vessel.handlingHours;
      const waitingHours = Math.max(0, startHours - vessel.etaHours);

      assignments.push({
        vesselId,
        berthId,
        startHours,
        endHours,
        waitingHours,
      });

      placed.add(vesselId);
      busyHours += vessel.handlingHours;
      previousEnd = endHours;

      if (endHours > makespanHours) makespanHours = endHours;
      totalWaitingHours += waitingHours;
    }

    berthBusyHours[berthId] = busyHours;
  }

  const unassigned: string[] = [];
  for (const vesselId of vessels.keys()) {
    if (!placed.has(vesselId)) unassigned.push(vesselId);
  }

  return {
    assignments,
    unassigned,
    totalWaitingHours,
    makespanHours,
    berthBusyHours,
  };
}

/**
 * Public entry point to the sweep: turn per-berth ordered vessel sequences
 * into a concrete plan. Used by the GA, ALNS, and exact solver so every
 * algorithm shares one feasibility/sweep semantics — a plan is feasible iff
 * its sequences sweep without overlap, which the sweep guarantees by
 * construction (start = max(ETA, previous end), tide-adjusted when enabled).
 */
export function sequencesToPlan(
  seqs: Map<string, string[]>,
  vessels: Vessel[],
  opts: SequenceSweepOptions = {},
): BerthPlan {
  assertPlanningInputs(vessels, []);
  const vesselMap = new Map<string, Vessel>();
  for (const vessel of vessels) vesselMap.set(vessel.id, vessel);
  return buildPlan(seqs, vesselMap, opts);
}

/**
 * Per-berth sequences implied by a plan: assignments grouped by berth,
 * ordered by start time. The inverse of sequencesToPlan up to re-sweeping.
 */
export function planToSequences(plan: BerthPlan): Map<string, string[]> {
  const seqs = new Map<string, string[]>();
  const byBerth = new Map<string, Assignment[]>();
  for (const a of plan.assignments) {
    const list = byBerth.get(a.berthId);
    if (list) list.push(a);
    else byBerth.set(a.berthId, [a]);
  }
  for (const [berthId, list] of byBerth) {
    list.sort((x, y) => x.startHours - y.startHours || compareIds(x.vesselId, y.vesselId));
    seqs.set(berthId, list.map((a) => a.vesselId));
  }
  return seqs;
}

/**
 * Greedy earliest-start placement.
 *
 * Vessels are consumed in the given order. Each vessel is placed on the
 * feasible berth that yields the earliest start time
 * (max(eta, berthAvailable), tide-adjusted when enabled), with ties broken
 * by berth id. Vessels with no feasible berth are simply skipped (they end
 * up unassigned).
 */
function greedySequences(
  ordered: Vessel[],
  berths: Berth[],
  opts: SweepOptions = {},
): Map<string, string[]> {
  const seqs = new Map<string, string[]>();
  const berthAvailable = new Map<string, number>();
  const tideWindows = opts.tideWindows ?? generateTideWindows(tideHorizon(ordered));

  for (const berth of berths) {
    seqs.set(berth.id, []);
    berthAvailable.set(berth.id, 0);
  }

  for (const vessel of ordered) {
    let bestBerth: Berth | null = null;
    let bestStart = Number.POSITIVE_INFINITY;

    for (const berth of berths) {
      if (!berthFeasible(vessel, berth)) continue;

      const available = berthAvailable.get(berth.id) ?? 0;
      let start = Math.max(vessel.etaHours, available);
      if (opts.tidesEnabled && needsTideWindow(vessel)) {
        start = nextTideWindowStart(start, tideWindows);
      }

      if (
        start < bestStart ||
        (start === bestStart && bestBerth !== null && compareIds(berth.id, bestBerth.id) < 0)
      ) {
        bestStart = start;
        bestBerth = berth;
      }
    }

    if (bestBerth === null) continue;

    const list = seqs.get(bestBerth.id);
    if (!list) continue;
    list.push(vessel.id);
    berthAvailable.set(bestBerth.id, bestStart + vessel.handlingHours);
  }

  return seqs;
}

/** Vessel ordering for greedy construction (ETA order, grain-first optional). */
function orderedVessels(vessels: Vessel[], grainPriority: boolean): Vessel[] {
  return vessels.slice().sort((a, b) => {
    if (grainPriority) {
      const ga = a.cargo === "grain" ? 0 : 1;
      const gb = b.cargo === "grain" ? 0 : 1;
      if (ga !== gb) return ga - gb;
    }
    return a.etaHours - b.etaHours || compareIds(a.id, b.id);
  });
}

function sweepOpts(opts: PlanOptions): SweepOptions {
  return { tidesEnabled: opts.tidesEnabled ?? false, tideWindows: undefined };
}

/**
 * First-come-first-served baseline: vessels are processed in ETA order
 * (ties broken by id) and each one takes the feasible berth that lets it start
 * earliest. This is the "greedy" algorithm in the comparison view.
 */
export function planNaive(vessels: Vessel[], berths: Berth[], opts: PlanOptions = {}): BerthPlan {
  assertPlanningInputs(vessels, berths);
  const vesselMap = new Map<string, Vessel>();
  for (const vessel of vessels) vesselMap.set(vessel.id, vessel);

  const ordered = orderedVessels(vessels, opts.grainPriority ?? false);
  const seqs = greedySequences(ordered, berths, sweepOpts(opts));
  return buildPlan(seqs, vesselMap, sweepOpts(opts));
}

/** Alias: the greedy algorithm in the three-way comparison. */
export const planGreedy = planNaive;

/** Weighted multi-objective value of a plan (lower is better). */
function objective(
  plan: BerthPlan,
  vessels: Vessel[],
  berths: Berth[],
  weights: ObjectiveWeights,
): number {
  return planEconomics(plan, vessels, berths, weights).objective;
}

interface MoveContext {
  movable: Vessel[];
  feasibleBerths: Map<string, Berth[]>;
  location: Map<string, string>;
}

/** One random relocate move: a vessel to a random position on a random feasible berth. */
function randomMove(
  seqs: Map<string, string[]>,
  ctx: MoveContext,
  rand: () => number,
): { nextSeqs: Map<string, string[]>; vesselId: string; targetBerthId: string } | null {
  const vessel = ctx.movable[Math.floor(rand() * ctx.movable.length)];
  const candidates = ctx.feasibleBerths.get(vessel.id);
  if (!candidates || candidates.length === 0) return null;

  const nextSeqs = cloneSeqs(seqs);
  const fromBerthId = ctx.location.get(vessel.id);
  if (fromBerthId !== undefined) {
    const fromList = nextSeqs.get(fromBerthId);
    if (fromList) {
      const idx = fromList.indexOf(vessel.id);
      if (idx >= 0) fromList.splice(idx, 1);
    }
  }

  const targetBerth = candidates[Math.floor(rand() * candidates.length)];
  const targetList = nextSeqs.get(targetBerth.id);
  if (!targetList) return null;

  const insertAt = Math.floor(rand() * (targetList.length + 1));
  targetList.splice(insertAt, 0, vessel.id);
  return { nextSeqs, vesselId: vessel.id, targetBerthId: targetBerth.id };
}

function setupSearch(
  vessels: Vessel[],
  berths: Berth[],
  opts: PlanOptions,
): {
  vesselMap: Map<string, Vessel>;
  currentSeqs: Map<string, string[]>;
  currentCost: number;
  bestPlan: BerthPlan;
  bestCost: number;
  ctx: MoveContext;
  sweep: SweepOptions;
  weights: ObjectiveWeights;
} {
  const vesselMap = new Map<string, Vessel>();
  for (const vessel of vessels) vesselMap.set(vessel.id, vessel);

  const sweep = sweepOpts(opts);
  const weights = opts.weights ?? { waiting: 1, fuel: 0, crane: 0 };
  const ordered = orderedVessels(vessels, opts.grainPriority ?? false);

  const currentSeqs = greedySequences(ordered, berths, sweep);
  const initialPlan = buildPlan(currentSeqs, vesselMap, sweep);
  const currentCost = objective(initialPlan, vessels, berths, weights);

  const feasibleBerths = new Map<string, Berth[]>();
  const movable: Vessel[] = [];
  for (const vessel of vessels) {
    const list = berths.filter((berth) => berthFeasible(vessel, berth));
    feasibleBerths.set(vessel.id, list);
    if (list.length > 0) movable.push(vessel);
  }

  const location = new Map<string, string>();
  for (const [berthId, list] of currentSeqs) {
    for (const vesselId of list) location.set(vesselId, berthId);
  }

  return {
    vesselMap,
    currentSeqs,
    currentCost,
    bestPlan: initialPlan,
    bestCost: currentCost,
    ctx: { movable, feasibleBerths, location },
    sweep,
    weights,
  };
}

/**
 * Simulated-annealing berth planner.
 *
 * Starts from a greedy solution, then repeatedly moves a single vessel to a
 * random position on a random feasible berth. The full plan is recomputed from
 * the sequences after every move, so the returned plan is always overlap-free
 * and never contains an infeasible vessel/berth pair.
 *
 * All randomness flows through mulberry32(seed), so identical inputs and seed
 * produce identical output.
 */
export function planOptimized(
  vessels: Vessel[],
  berths: Berth[],
  opts: PlanOptions = {},
): BerthPlan {
  const seed = opts.seed ?? DEFAULT_SEED;
  const timeLimitMs = opts.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS;

  assertPlanningInputs(vessels, berths);
  if (vessels.length === 0 || berths.length === 0) {
    return buildPlan(new Map(), new Map(), sweepOpts(opts));
  }

  const s = setupSearch(vessels, berths, opts);
  if (s.ctx.movable.length === 0) return s.bestPlan;

  let currentSeqs = s.currentSeqs;
  let currentCost = s.currentCost;
  let bestPlan = s.bestPlan;
  let bestCost = s.bestCost;

  const rand = mulberry32(seed);
  const maxIterations = Math.max(64, Math.floor(timeLimitMs * ITERATIONS_PER_MS));

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const progress = maxIterations <= 1 ? 1 : iteration / (maxIterations - 1);
    const temperature = SA_TEMP_START * Math.pow(SA_TEMP_END / SA_TEMP_START, progress);

    const move = randomMove(currentSeqs, s.ctx, rand);
    if (!move) continue;

    const nextPlan = buildPlan(move.nextSeqs, s.vesselMap, s.sweep);
    const nextCost = objective(nextPlan, vessels, berths, s.weights);
    const delta = nextCost - currentCost;

    const accept = delta <= 0 || rand() < Math.exp(-delta / Math.max(temperature, 1e-9));

    if (accept) {
      currentSeqs = move.nextSeqs;
      currentCost = nextCost;
      s.ctx.location.set(move.vesselId, move.targetBerthId);
      if (nextCost < bestCost) {
        bestCost = nextCost;
        bestPlan = nextPlan;
      }
    }
  }

  return bestPlan;
}

/**
 * Tabu-search berth planner.
 *
 * Same sequence representation and neighbourhood as simulated annealing
 * (relocate one vessel), but with memory: a (vessel, target berth) move stays
 * tabu for TABU_TENURE iterations. Each iteration samples several candidate
 * moves and applies the best non-tabu one — even when it is worse than the
 * current solution, which is how tabu escapes local minima. A tabu move is
 * still allowed (aspiration) when it beats the best solution found so far.
 * Deterministic for a fixed seed.
 */
export function planTabu(
  vessels: Vessel[],
  berths: Berth[],
  opts: PlanOptions = {},
): BerthPlan {
  const seed = opts.seed ?? DEFAULT_SEED;
  const timeLimitMs = opts.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS;

  if (vessels.length === 0 || berths.length === 0) {
    return buildPlan(new Map(), new Map(), sweepOpts(opts));
  }

  const s = setupSearch(vessels, berths, opts);
  if (s.ctx.movable.length === 0) return s.bestPlan;

  let currentSeqs = s.currentSeqs;
  let bestPlan = s.bestPlan;
  let bestCost = s.bestCost;

  // (vesselId|berthId) -> iteration after which the move is allowed again.
  const tabuUntil = new Map<string, number>();
  const rand = mulberry32(seed + 7919);
  assertPlanningInputs(vessels, berths);
  const maxIterations = Math.max(64, Math.floor(timeLimitMs * ITERATIONS_PER_MS));

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let bestMove: {
      nextSeqs: Map<string, string[]>;
      vesselId: string;
      targetBerthId: string;
      cost: number;
    } | null = null;

    for (let sample = 0; sample < TABU_CANDIDATES_PER_ITERATION; sample++) {
      const move = randomMove(currentSeqs, s.ctx, rand);
      if (!move) continue;
      const candidatePlan = buildPlan(move.nextSeqs, s.vesselMap, s.sweep);
      const candidateCost = objective(candidatePlan, vessels, berths, s.weights);
      const key = `${move.vesselId}|${move.targetBerthId}`;
      const isTabu = (tabuUntil.get(key) ?? -1) > iteration;
      // Aspiration: a tabu move is allowed when it beats the global best.
      if (isTabu && candidateCost >= bestCost) continue;
      if (bestMove === null || candidateCost < bestMove.cost) {
        bestMove = { ...move, cost: candidateCost };
      }
    }

    if (bestMove === null) continue;

    currentSeqs = bestMove.nextSeqs;
    s.ctx.location.set(bestMove.vesselId, bestMove.targetBerthId);
    tabuUntil.set(`${bestMove.vesselId}|${bestMove.targetBerthId}`, iteration + TABU_TENURE);

    if (bestMove.cost < bestCost) {
      bestCost = bestMove.cost;
      bestPlan = buildPlan(currentSeqs, s.vesselMap, s.sweep);
    }
  }

  return bestPlan;
}

/**
 * Run greedy, simulated annealing, tabu search, genetic algorithm, and ALNS
 * on the same vessel set with the same weights, crane-schedule every plan
 * against the shared pool, and pick the winner by weighted objective (ties
 * resolved in greedy → annealing → tabu → GA → ALNS order, deterministic).
 *
 * Fairness is enforced, not just assumed: every result carries an
 * `inputFingerprint` of the exact instance, weights, tide flag and time
 * budget it was graded on, and each runner is checked before/after for
 * mutations of the shared input arrays (a planner that sorted or spliced
 * its input in place would silently corrupt every runner after it).
 */
export function compareAlgorithms(
  vessels: Vessel[],
  berths: Berth[],
  opts: PlanOptions = {},
): ComparisonResult {
  assertPlanningInputs(vessels, berths);
  const weights = opts.weights ?? { waiting: 1, fuel: 0, crane: 0 };
  const tidesEnabled = opts.tidesEnabled ?? false;
  const fingerprint = comparisonFingerprint(vessels, berths, opts);

  const runners: Array<{ id: AlgorithmId; label: string; fn: (v: Vessel[], b: Berth[]) => BerthPlan }> = [
    { id: "greedy", label: "Greedy (FCFS)", fn: (v, b) => planNaive(v, b, opts) },
    { id: "annealing", label: "Simulated annealing", fn: (v, b) => planOptimized(v, b, opts) },
    { id: "tabu", label: "Tabu search", fn: (v, b) => planTabu(v, b, opts) },
    { id: "ga", label: "Genetic algorithm", fn: (v, b) => planGA(v, b, opts) },
    { id: "alns", label: "ALNS", fn: (v, b) => planALNS(v, b, opts) },
  ];

  const results: AlgorithmResult[] = runners.map((runner) => {
    const before = canonicalInstanceString(vessels, berths);
    const rawPlan = runner.fn(vessels, berths);
    const after = canonicalInstanceString(vessels, berths);
    if (before !== after) {
      throw new Error(
        `comparison fairness violation: ${runner.id} mutated the shared planning inputs; ` +
          "all runners must see identical instances",
      );
    }
    const { plan, schedule } = scheduleCranes(rawPlan, vessels, berths, {
      poolLimit: CRANE_POOL_LIMIT,
      tidesEnabled,
    });
    return {
      id: runner.id,
      label: runner.label,
      plan,
      craneSchedule: schedule,
      economics: planEconomics(plan, vessels, berths, weights),
      inputFingerprint: fingerprint,
    };
  });

  assertFairComparison(results);

  let winner: AlgorithmId = "greedy";
  let winnerCost = Number.POSITIVE_INFINITY;
  for (const result of results) {
    if (result.economics.objective < winnerCost - EPS) {
      winnerCost = result.economics.objective;
      winner = result.id;
    }
  }

  return { results, winner };
}

/**
 * FNV-1a 32-bit hash (pure JS: berth.ts is bundled for the browser, so no
 * node:crypto here). Used only for fairness fingerprinting, not security.
 */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Canonical, order-independent rendering of a (vessels, berths) instance:
 * two structurally identical inputs hash the same regardless of array order.
 */
export function canonicalInstanceString(vessels: Vessel[], berths: Berth[]): string {
  const vs = vessels
    .map((v) =>
      [v.id, v.name, v.line, v.etaHours, v.lengthM, v.draftM, v.cargo, v.handlingHours, v.teu, v.origin].join(
        "|",
      ),
    )
    .sort()
    .join(";");
  const bs = berths
    .map((b) => [b.id, b.name, b.lengthM, b.grainCapable, b.cranes].join("|"))
    .sort()
    .join(";");
  return vs + "#" + bs;
}

/**
 * Fingerprint of everything a comparison grade depends on: the instance,
 * the objective weights, the tide flag, and the optimisation budgets
 * (timeLimitMs, seed). Two results with equal fingerprints were graded on
 * identical instances, objectives and budgets.
 */
export function comparisonFingerprint(vessels: Vessel[], berths: Berth[], opts: PlanOptions = {}): string {
  const weights = opts.weights ?? { waiting: 1, fuel: 0, crane: 0 };
  return fnv1a(
    canonicalInstanceString(vessels, berths) +
      "#" +
      JSON.stringify({
        weights,
        tidesEnabled: opts.tidesEnabled ?? false,
        timeLimitMs: opts.timeLimitMs ?? null,
        seed: opts.seed ?? null,
      }),
  );
}

/**
 * Fail loudly if a comparison mixes results graded on different instances,
 * objectives, or budgets. Every result from `compareAlgorithms` carries its
 * fingerprint, so a mixed bag can only arise from hand-assembled results —
 * exactly the mistake this guard exists to catch.
 */
export function assertFairComparison(results: AlgorithmResult[]): void {
  if (results.length === 0) {
    throw new Error("fair comparison: no results to compare");
  }
  const first = results[0].inputFingerprint;
  if (!first) {
    throw new Error(
      "fair comparison: result missing inputFingerprint (not produced by compareAlgorithms?)",
    );
  }
  for (const r of results) {
    if (r.inputFingerprint !== first) {
      throw new Error(
        `fair comparison: mismatched comparison — ${r.id} was graded on a different ` +
          `instance/objective/budget than ${results[0].id}; refusing to pick a winner`,
      );
    }
  }
}

/**
 * Validate a drag-and-drop move: vessel `vesselId` to `targetBerthId`
 * starting at `requestedStart` (hours). All checks run against the current
 * plan; the moved vessel's own assignment is ignored.
 */
export function validateMove(
  plan: BerthPlan,
  vessels: Vessel[],
  berths: Berth[],
  vesselId: string,
  targetBerthId: string,
  requestedStart: number,
  opts: { poolLimit?: number; tidesEnabled?: boolean; tideWindows?: TideWindow[] } = {},
): DragValidation {
  assertPlanningInputs(vessels, berths);
  const vesselById = new Map(vessels.map((v) => [v.id, v]));
  const berthById = new Map(berths.map((b) => [b.id, b]));
  const vessel = vesselById.get(vesselId);
  const berth = berthById.get(targetBerthId);
  if (!vessel) return { valid: false, reason: "Unknown vessel." };
  if (!berth) return { valid: false, reason: "Unknown berth." };

  if (!berthFeasible(vessel, berth)) {
    if (vessel.lengthM > berth.lengthM) {
      return {
        valid: false,
        reason: `${vessel.name} (${vessel.lengthM}m) is too long for ${berth.name} (${berth.lengthM}m).`,
      };
    }
    return {
      valid: false,
      reason: `${vessel.name} carries grain, but ${berth.name} is not grain-capable.`,
    };
  }

  if (requestedStart < vessel.etaHours - EPS) {
    return {
      valid: false,
      reason: `Cannot berth before ETA h+${vessel.etaHours.toFixed(1)}.`,
    };
  }

  const tidesEnabled = opts.tidesEnabled ?? false;
  if (tidesEnabled && needsTideWindow(vessel)) {
    const windows = opts.tideWindows ?? generateTideWindows(tideHorizon(vessels));
    if (!isInTideWindow(requestedStart, windows)) {
      const next = nextTideWindowStart(requestedStart, windows);
      return {
        valid: false,
        reason: `${vessel.name} draws ${vessel.draftM}m and may only enter during a tide window. Next window opens h+${next.toFixed(1)}.`,
      };
    }
  }

  const requestedEnd = requestedStart + vessel.handlingHours;
  for (const a of plan.assignments) {
    if (a.berthId !== targetBerthId || a.vesselId === vesselId) continue;
    if (requestedStart < a.endHours - EPS && requestedEnd > a.startHours + EPS) {
      const other = vesselById.get(a.vesselId);
      return {
        valid: false,
        reason: `Overlaps ${other?.name ?? a.vesselId} on ${berth.name} (h+${a.startHours.toFixed(1)}–h+${a.endHours.toFixed(1)}).`,
      };
    }
  }

  const poolLimit = opts.poolLimit ?? CRANE_POOL_LIMIT;
  const free = cranesFreeAt(plan.assignments, vessels, berths, vesselId, targetBerthId, requestedStart, poolLimit);
  if (free < 0) {
    const needed = cranesForVessel(vessel, berth);
    return {
      valid: false,
      reason: `Crane pool over-allocated at that time: ${vessel.name} needs ${needed} crane(s), but only ${free + needed} of ${poolLimit} are free in that window. Try a later slot.`,
    };
  }

  return { valid: true };
}

/**
 * Rebuild the plan after an accepted drag: move the vessel into the target
 * berth's sequence at the drop position, re-sweep (tide-aware) and
 * re-schedule cranes. Returns the new plan and its crane schedule.
 */
export function rebuildAfterMove(
  plan: BerthPlan,
  vessels: Vessel[],
  berths: Berth[],
  vesselId: string,
  targetBerthId: string,
  requestedStart: number,
  opts: PlanOptions = {},
): { plan: BerthPlan; craneSchedule: ReturnType<typeof scheduleCranes>["schedule"] } {
  assertPlanningInputs(vessels, berths);
  const seqs = new Map<string, string[]>();
  for (const berth of berths) seqs.set(berth.id, []);

  // Rebuild sequences from the current plan, minus the moved vessel.
  const byBerth = new Map<string, Assignment[]>();
  for (const a of plan.assignments) {
    if (a.vesselId === vesselId) continue;
    const list = byBerth.get(a.berthId);
    if (list) list.push(a);
    else byBerth.set(a.berthId, [a]);
  }
  for (const [berthId, list] of byBerth) {
    list.sort((x, y) => x.startHours - y.startHours || compareIds(x.vesselId, y.vesselId));
    seqs.set(berthId, list.map((a) => a.vesselId));
  }

  // Insert the moved vessel into the target berth at the drop position.
  const target = seqs.get(targetBerthId) ?? [];
  const targetAssignments = (byBerth.get(targetBerthId) ?? []).slice().sort((x, y) => x.startHours - y.startHours);
  let insertAt = targetAssignments.length;
  for (let i = 0; i < targetAssignments.length; i++) {
    if (targetAssignments[i].startHours > requestedStart + EPS) {
      insertAt = i;
      break;
    }
  }
  target.splice(insertAt, 0, vesselId);
  seqs.set(targetBerthId, target);

  const vesselMap = new Map(vessels.map((v) => [v.id, v]));
  const rawPlan = buildPlan(seqs, vesselMap, {
    ...sweepOpts(opts),
    notBefore: new Map([[vesselId, requestedStart]]),
  });
  const { plan: timedPlan, schedule } = scheduleCranes(rawPlan, vessels, berths, {
    poolLimit: CRANE_POOL_LIMIT,
    tidesEnabled: opts.tidesEnabled ?? false,
    notBefore: new Map([[vesselId, requestedStart]]),
  });
  return { plan: timedPlan, craneSchedule: schedule };
}
