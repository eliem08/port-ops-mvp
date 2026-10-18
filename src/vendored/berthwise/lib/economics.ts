import type { Berth, BerthPlan, ObjectiveWeights, PlanEconomics, Vessel } from "./types";

/**
 * Planning economics: fuel burned at anchor + crane cost.
 *
 * All figures are transparent planning proxies, not measured port data:
 * fuel burn rates are stylised per-cargo averages, and the crane rate is a
 * round planning figure. They exist so the multi-objective planner can trade
 * waiting time against fuel and crane spend — the exact rates are documented
 * in the README and adjustable in one place here.
 */

/** Fuel burned per waiting hour at anchor, tonnes/hour by cargo. */
export const FUEL_BURN_T_PER_HOUR: Record<string, number> = {
  container: 0.9,
  grain: 0.6,
};

/** Crane operating cost, USD per crane-hour. */
export const CRANE_COST_USD_PER_HOUR = 180;

/** Total quay cranes shared across all berths (sum of berth cranes is 9). */
export const CRANE_POOL_LIMIT = 8;

/** Reference scales normalising the weighted objective's three terms. */
export const OBJECTIVE_REFERENCE = {
  waitingHours: 40,
  fuelTonnes: 40,
  craneCostUsd: 4000,
} as const;

/** Cranes a vessel needs: containers scale with TEU, grain uses one crane. */
export function cranesForVessel(vessel: Vessel, berth: Berth): number {
  if (vessel.cargo === "grain") return Math.min(1, berth.cranes);
  const byTeu = Math.ceil(vessel.teu / 1200);
  return Math.max(1, Math.min(byTeu, berth.cranes));
}

/** Normalise raw slider weights to sum to 1; all-zero falls back to waiting-only. */
export function normalizeWeights(weights: ObjectiveWeights): ObjectiveWeights {
  const w = Math.max(0, weights.waiting);
  const f = Math.max(0, weights.fuel);
  const c = Math.max(0, weights.crane);
  const sum = w + f + c;
  if (sum <= 0) return { waiting: 1, fuel: 0, crane: 0 };
  return { waiting: w / sum, fuel: f / sum, crane: c / sum };
}

/**
 * Fuel + crane roll-up for a plan. Crane counts come from `cranesForVessel`
 * (the same rule the crane scheduler uses), so economics and scheduling agree.
 */
export function planEconomics(
  plan: BerthPlan,
  vessels: Vessel[],
  berths: Berth[],
  weights: ObjectiveWeights = { waiting: 1, fuel: 0, crane: 0 },
): PlanEconomics {
  const vesselById = new Map(vessels.map((v) => [v.id, v]));
  const berthById = new Map(berths.map((b) => [b.id, b]));

  let fuelTonnes = 0;
  let craneHours = 0;

  for (const a of plan.assignments) {
    const vessel = vesselById.get(a.vesselId);
    const berth = berthById.get(a.berthId);
    if (!vessel || !berth) continue;
    const burn = FUEL_BURN_T_PER_HOUR[vessel.cargo] ?? 0.9;
    fuelTonnes += a.waitingHours * burn;
    const duration = Math.max(0, a.endHours - a.startHours);
    craneHours += duration * cranesForVessel(vessel, berth);
  }

  const craneCostUsd = craneHours * CRANE_COST_USD_PER_HOUR;
  const w = normalizeWeights(weights);
  const objective =
    w.waiting * (plan.totalWaitingHours / OBJECTIVE_REFERENCE.waitingHours) +
    w.fuel * (fuelTonnes / OBJECTIVE_REFERENCE.fuelTonnes) +
    w.crane * (craneCostUsd / OBJECTIVE_REFERENCE.craneCostUsd) +
    0.01 * (plan.makespanHours / 100);

  return {
    waitingHours: plan.totalWaitingHours,
    fuelTonnes,
    craneHours,
    craneCostUsd,
    makespanHours: plan.makespanHours,
    objective,
  };
}
