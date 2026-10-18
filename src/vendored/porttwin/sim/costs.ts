/**
 * Cost model: turns simulation KPIs into dollar estimates per scenario.
 *
 * The twin is a landside, truck-level model — it does not simulate vessels,
 * so "demurrage" here is a truck-hour proxy: waiting beyond a free-time
 * allowance is priced per truck-hour, the same way detention/demurrage is
 * billed per container-day in practice. All rates are editable in the UI
 * and are clearly labelled as illustrative defaults, not port tariffs.
 *
 * Line items:
 *  - Demurrage & detention: Σ max(0, gateWait − freeHours) × rate.
 *  - Truck waiting: total gate-wait truck-hours × driver/opportunity rate.
 *  - Fuel / idling: wait-hours × litres-per-idle-hour × fuel price.
 *  - Crane-hours: yard + berth busy crane-hours × rate.
 *  - Carbon: CO₂ tonnes × carbon price (policy placeholder).
 */

import type { Kpis, SimResult } from "./types";

/** Dollar rates for the cost model. All per-hour unless noted. */
export interface CostRates {
  /** $ per truck-hour of gate waiting beyond the free allowance. */
  demurragePerTruckHour: number;
  /** Free waiting allowance before demurrage starts, in hours. */
  demurrageFreeHours: number;
  /** $ per truck-hour waiting at the gate (driver time + opportunity). */
  truckWaitingPerHour: number;
  /** Diesel burned per idle truck-hour, litres. */
  fuelLitersPerIdleHour: number;
  /** $ per litre of diesel. */
  fuelPricePerLiter: number;
  /** $ per busy crane-hour (yard + berth). */
  craneCostPerHour: number;
  /** $ per tonne of CO₂ (carbon price placeholder). */
  carbonPricePerTonne: number;
}

/**
 * Illustrative defaults — plausible Casablanca-adjacent figures, NOT
 * official port tariffs. The UI invites the buyer to plug in real rates.
 */
export const DEFAULT_COST_RATES: CostRates = {
  demurragePerTruckHour: 75,
  demurrageFreeHours: 2,
  truckWaitingPerHour: 45,
  fuelLitersPerIdleHour: 2.5,
  fuelPricePerLiter: 1.2,
  craneCostPerHour: 180,
  carbonPricePerTonne: 50,
};

export interface CostLineItem {
  key: string;
  label: string;
  amount: number;
  detail: string;
  /**
   * Provenance of the line's inputs: what was MEASURED from the
   * simulation vs what is an ILLUSTRATIVE ASSUMPTION (editable rates).
   * Every dollar figure mixes the two — this field keeps them distinct.
   */
  provenance: { measured: string; assumed: string };
}

export interface CostBreakdown {
  items: CostLineItem[];
  /** Sum of all line items, $ per modelled day. */
  total: number;
  /** Truck-hours of waiting that exceeded the free allowance. */
  demurrageHours: number;
}

function money(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Price one simulation result. `waitSamplesMin` is required for the
 * demurrage line; pass `result.waitSamplesMin`.
 */
export function computeCosts(
  kpis: Kpis,
  waitSamplesMin: number[],
  rates: CostRates = DEFAULT_COST_RATES
): CostBreakdown {
  const demurrageHours = waitSamplesMin.reduce(
    (sum, w) => sum + Math.max(0, w / 60 - rates.demurrageFreeHours),
    0
  );
  const demurrage = demurrageHours * rates.demurragePerTruckHour;
  const waiting = kpis.totalWaitHours * rates.truckWaitingPerHour;
  const fuel =
    kpis.totalWaitHours * rates.fuelLitersPerIdleHour * rates.fuelPricePerLiter;
  const crane =
    (kpis.yardCraneHours + kpis.berthCraneHours) * rates.craneCostPerHour;
  const carbon = kpis.co2Tonnes * rates.carbonPricePerTonne;

  const items: CostLineItem[] = [
    {
      key: "demurrage",
      label: "Demurrage & detention",
      amount: money(demurrage),
      detail: `${demurrageHours.toFixed(0)} truck-h beyond ${rates.demurrageFreeHours}h free`,
      provenance: {
        measured: "per-truck gate waits (simulation)",
        assumed: "free-allowance hours + $/truck-h rate",
      },
    },
    {
      key: "waiting",
      label: "Truck waiting (driver + opportunity)",
      amount: money(waiting),
      detail: `${kpis.totalWaitHours.toFixed(0)} truck-h waiting`,
      provenance: {
        measured: "total gate-wait truck-hours (simulation)",
        assumed: "$/truck-h driver + opportunity rate",
      },
    },
    {
      key: "fuel",
      label: "Fuel / idling",
      amount: money(fuel),
      detail: `${(
        kpis.totalWaitHours * rates.fuelLitersPerIdleHour
      ).toFixed(0)} L diesel @ $${rates.fuelPricePerLiter.toFixed(2)}/L`,
      provenance: {
        measured: "total gate-wait truck-hours (simulation)",
        assumed: "litres per idle hour + diesel price",
      },
    },
    {
      key: "crane",
      label: "Crane-hours",
      amount: money(crane),
      detail: `${(kpis.yardCraneHours + kpis.berthCraneHours).toFixed(0)} busy crane-h`,
      provenance: {
        measured: "busy yard + berth crane-hours (simulation)",
        assumed: "$/crane-h rate",
      },
    },
    {
      key: "carbon",
      label: "Carbon (policy placeholder)",
      amount: money(carbon),
      detail: `${kpis.co2Tonnes.toFixed(1)} t CO₂ @ $${rates.carbonPricePerTonne}/t`,
      provenance: {
        measured: "idle truck-hours (simulation)",
        assumed: "kg CO₂ per idle hour + carbon price",
      },
    },
  ];

  return {
    items,
    total: money(items.reduce((s, i) => s + i.amount, 0)),
    demurrageHours: money(demurrageHours),
  };
}

/** Cost one full simulation result. */
export function computeCostsForResult(
  result: SimResult,
  rates: CostRates = DEFAULT_COST_RATES
): CostBreakdown {
  return computeCosts(result.kpis, result.waitSamplesMin, rates);
}

/** Signed delta: current total minus baseline total. Negative = savings. */
export function costDelta(current: CostBreakdown, baseline: CostBreakdown): number {
  return Math.round((current.total - baseline.total) * 100) / 100;
}
