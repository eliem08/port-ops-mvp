import type { Berth, BerthPlan, PlanOptions, Vessel } from "./types";
import { mulberry32 } from "./rng";
import { berthFeasible, planNaive, planToSequences, sequencesToPlan } from "./berth";
import { assertPlanningInputs } from "./validate";
import { planEconomics } from "./economics";

/**
 * Adaptive Large Neighborhood Search (ALNS) for the discrete dynamic BAP,
 * following the framework of Ropke & Pisinger (2006).
 *
 * Representation: per-berth ordered vessel sequences (same as SA/tabu), so
 * every incumbent is a feasible plan by construction.
 *
 * Destroy operators (remove k vessels):
 *   - random: uniform random subset;
 *   - worst-cost: vessels with the largest anchorage waiting in the current
 *     plan, perturbed by noise so the same vessels are not removed every time;
 *   - time-window: all vessels whose planned start falls in a random 12h window.
 *
 * Repair: regret-2 insertion — for every removed vessel, evaluate every
 * feasible (berth, position) insertion by full re-sweep; insert the vessel
 * with the largest regret (2nd-best − best insertion cost) first, at its
 * best position. This is the expensive step, so iteration count is bounded.
 *
 * Adaptation: operator weights start equal and are updated every segment
 * from observed scores (σ1 = 33 new global best, σ2 = 9 better than current,
 * σ3 = 13 accepted), with reaction factor 0.1; selection is roulette-wheel.
 *
 * Acceptance: simulated-annealing rule with a fixed cooling schedule.
 * Deterministic for a fixed seed: fixed iteration count, no wall clock.
 */

const ITERATIONS = 400;
const SEGMENT_LENGTH = 50;
const REACTION_FACTOR = 0.1;
const SIGMA_NEW_BEST = 33;
const SIGMA_BETTER = 9;
const SIGMA_ACCEPTED = 13;
const TEMP_START = 5;
const TEMP_END = 0.05;
const TIME_WINDOW_HOURS = 12;
const DEFAULT_SEED = 42;

type DestroyId = "random" | "worst" | "timeWindow";

const DESTROY_OPERATORS: DestroyId[] = ["random", "worst", "timeWindow"];

function cloneSeqs(seqs: Map<string, string[]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [k, v] of seqs) out.set(k, v.slice());
  return out;
}

function objectiveOf(
  seqs: Map<string, string[]>,
  vessels: Vessel[],
  berths: Berth[],
  opts: PlanOptions,
): number {
  const plan = sequencesToPlan(seqs, vessels, { tidesEnabled: opts.tidesEnabled ?? false });
  return planEconomics(plan, vessels, berths, opts.weights).objective;
}

function destroy(
  seqs: Map<string, string[]>,
  vessels: Vessel[],
  plan: BerthPlan,
  operator: DestroyId,
  k: number,
  rand: () => number,
): { reduced: Map<string, string[]>; removed: Vessel[] } {
  const vesselById = new Map(vessels.map((v) => [v.id, v]));
  const waitingById = new Map(plan.assignments.map((a) => [a.vesselId, a.waitingHours]));
  const startById = new Map(plan.assignments.map((a) => [a.vesselId, a.startHours]));
  const placedIds = [...plan.assignments.map((a) => a.vesselId)];
  if (placedIds.length === 0) return { reduced: cloneSeqs(seqs), removed: [] };

  const count = Math.min(k, placedIds.length);
  let toRemove: string[] = [];

  if (operator === "random") {
    const shuffled = placedIds.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    toRemove = shuffled.slice(0, count);
  } else if (operator === "worst") {
    // Noise-perturbed waiting: worst vessels first, ties broken randomly.
    const scored = placedIds
      .map((id) => ({ id, score: (waitingById.get(id) ?? 0) + rand() * 4 }))
      .sort((a, b) => b.score - a.score);
    toRemove = scored.slice(0, count).map((x) => x.id);
  } else {
    // Time-window: pick a random centre, remove vessels starting nearby.
    const starts = [...startById.values()];
    const lo = Math.min(...starts);
    const hi = Math.max(...starts);
    const centre = lo + rand() * Math.max(0, hi - lo);
    const inWindow = placedIds.filter((id) => {
      const s = startById.get(id) ?? 0;
      return s >= centre - TIME_WINDOW_HOURS / 2 && s <= centre + TIME_WINDOW_HOURS / 2;
    });
    const shuffled = inWindow.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    toRemove = shuffled.slice(0, count);
    // Fall back to random removals if the window caught too few vessels.
    if (toRemove.length < count) {
      const rest = placedIds.filter((id) => !toRemove.includes(id));
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      toRemove = [...toRemove, ...rest.slice(0, count - toRemove.length)];
    }
  }

  const removeSet = new Set(toRemove);
  const reduced = new Map<string, string[]>();
  for (const [berthId, list] of seqs) {
    reduced.set(
      berthId,
      list.filter((id) => !removeSet.has(id)),
    );
  }
  const removed = toRemove
    .map((id) => vesselById.get(id))
    .filter((v): v is Vessel => v !== undefined);
  return { reduced, removed };
}

/** Regret-2 insertion: repeatedly insert the removed vessel with the largest regret. */
function repair(
  seqs: Map<string, string[]>,
  removed: Vessel[],
  vessels: Vessel[],
  berths: Berth[],
  opts: PlanOptions,
): Map<string, string[]> {
  const working = cloneSeqs(seqs);
  const remaining = removed.slice();

  while (remaining.length > 0) {
    let bestVesselIdx = -1;
    let bestInsertion: { berthId: string; position: number } | null = null;
    let bestRegret = -Infinity;

    for (let vi = 0; vi < remaining.length; vi++) {
      const vessel = remaining[vi];
      let bestCost = Infinity;
      let secondCost = Infinity;
      let bestPos: { berthId: string; position: number } | null = null;

      for (const berth of berths) {
        if (!berthFeasible(vessel, berth)) continue;
        const list = working.get(berth.id) ?? [];
        for (let pos = 0; pos <= list.length; pos++) {
          const trial = cloneSeqs(working);
          const target = trial.get(berth.id) ?? [];
          target.splice(pos, 0, vessel.id);
          trial.set(berth.id, target);
          const cost = objectiveOf(trial, vessels, berths, opts);
          if (cost < bestCost) {
            secondCost = bestCost;
            bestCost = cost;
            bestPos = { berthId: berth.id, position: pos };
          } else if (cost < secondCost) {
            secondCost = cost;
          }
        }
      }

      // No feasible insertion (vessel fits nowhere): leave it unassigned.
      if (bestPos === null) continue;
      const regret = Number.isFinite(secondCost) ? secondCost - bestCost : 0;
      if (regret > bestRegret) {
        bestRegret = regret;
        bestVesselIdx = vi;
        bestInsertion = bestPos;
      }
    }

    if (bestVesselIdx === -1 || bestInsertion === null) break;
    const vessel = remaining[bestVesselIdx];
    const target = working.get(bestInsertion.berthId) ?? [];
    target.splice(bestInsertion.position, 0, vessel.id);
    working.set(bestInsertion.berthId, target);
    remaining.splice(bestVesselIdx, 1);
  }

  return working;
}

/**
 * ALNS berth planner. Returns the best plan found. Deterministic for a
 * fixed seed.
 */
export function planALNS(
  vessels: Vessel[],
  berths: Berth[],
  opts: PlanOptions = {},
): BerthPlan {
  const seed = opts.seed ?? DEFAULT_SEED;
  assertPlanningInputs(vessels, berths);
  if (vessels.length === 0 || berths.length === 0) {
    return sequencesToPlan(new Map(), vessels, { tidesEnabled: opts.tidesEnabled ?? false });
  }

  const rand = mulberry32(seed + 2654435761);
  const greedyPlan = planNaive(vessels, berths, opts);
  let currentSeqs = planToSequences(greedyPlan);
  let currentCost = objectiveOf(currentSeqs, vessels, berths, opts);
  let bestSeqs = cloneSeqs(currentSeqs);
  let bestCost = currentCost;

  const weights = new Map<DestroyId, number>(DESTROY_OPERATORS.map((op) => [op, 1]));
  const scores = new Map<DestroyId, number>(DESTROY_OPERATORS.map((op) => [op, 0]));
  const uses = new Map<DestroyId, number>(DESTROY_OPERATORS.map((op) => [op, 0]));

  const destroyCount = Math.max(2, Math.round(vessels.length * 0.3));

  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    // Roulette-wheel operator selection.
    const totalWeight = DESTROY_OPERATORS.reduce((s, op) => s + (weights.get(op) ?? 1), 0);
    let pick = rand() * totalWeight;
    let operator: DestroyId = DESTROY_OPERATORS[0];
    for (const op of DESTROY_OPERATORS) {
      pick -= weights.get(op) ?? 1;
      if (pick <= 0) {
        operator = op;
        break;
      }
    }
    uses.set(operator, (uses.get(operator) ?? 0) + 1);

    const currentPlan = sequencesToPlan(currentSeqs, vessels, {
      tidesEnabled: opts.tidesEnabled ?? false,
    });
    const { reduced, removed } = destroy(currentSeqs, vessels, currentPlan, operator, destroyCount, rand);
    const candidateSeqs = repair(reduced, removed, vessels, berths, opts);
    const candidateCost = objectiveOf(candidateSeqs, vessels, berths, opts);

    const progress = ITERATIONS <= 1 ? 1 : iteration / (ITERATIONS - 1);
    const temperature = TEMP_START * Math.pow(TEMP_END / TEMP_START, progress);
    const delta = candidateCost - currentCost;
    const accept = delta <= 0 || rand() < Math.exp(-delta / Math.max(temperature, 1e-9));

    let sigma = 0;
    if (candidateCost < bestCost - 1e-9) {
      bestCost = candidateCost;
      bestSeqs = cloneSeqs(candidateSeqs);
      sigma = SIGMA_NEW_BEST;
    } else if (candidateCost < currentCost) {
      sigma = SIGMA_BETTER;
    } else if (accept) {
      sigma = SIGMA_ACCEPTED;
    }
    scores.set(operator, (scores.get(operator) ?? 0) + sigma);

    if (accept) {
      currentSeqs = candidateSeqs;
      currentCost = candidateCost;
    }

    // End of segment: adapt operator weights from observed scores.
    if ((iteration + 1) % SEGMENT_LENGTH === 0 || iteration === ITERATIONS - 1) {
      for (const op of DESTROY_OPERATORS) {
        const useCount = uses.get(op) ?? 0;
        const avgScore = useCount > 0 ? (scores.get(op) ?? 0) / useCount : 0;
        const old = weights.get(op) ?? 1;
        weights.set(op, (1 - REACTION_FACTOR) * old + REACTION_FACTOR * Math.max(avgScore, 0.01));
        scores.set(op, 0);
        uses.set(op, 0);
      }
    }
  }

  return sequencesToPlan(bestSeqs, vessels, { tidesEnabled: opts.tidesEnabled ?? false });
}
