/**
 * lib/pricing.ts
 *
 * Congestion pricing as a MECHANISM (not a tariff claim).
 *
 * Idea: slots are priced by time of day and by load. Carriers respond by
 * re-centring their preferred windows toward cheaper slots, trading a small
 * schedule displacement against a lower slot price. The terminal re-optimizes
 * on the shifted demand; the panel shows whether the peak flattened and at
 * what revenue.
 *
 * What this is: an illustrative mechanism-design experiment on synthetic
 * demand. Willingness-to-pay and value-of-time are SYNTHETIC per-truck
 * draws (seeded), not measured carrier behaviour. Real-world analogues
 * exist (e.g. time-of-day gate pricing programs at major container ports),
 * but nothing here is a claim about Casablanca's actual tariffs, which are
 * not public in this demo's data.
 *
 * Mechanism, precisely:
 *  • Slot price:  p(g,s) = P0 · tier(s) · (1 + σ · loadFactor(g,s))
 *    where tier(s) is a time-of-day multiplier (peak 1.8, shoulder 1.15,
 *    off-peak 0.6) and loadFactor is the slot's load / capacity in the
 *    base (unpriced) plan.
 *  • Carrier choice: each truck picks the slot minimizing generalized
 *    cost  p + VoT_i · displacement / 60, searching ±maxShift minutes
 *    around its preferred window. Displacement is measured from the
 *    NEAREST EDGE of the preferred window (0 for any slot inside the
 *    window): shifting to an adjacent slot is nearly free, which is what
 *    makes the price signal bite. VoT_i (value of time, $/h) is a seeded
 *    synthetic draw.
 *  • The shifted demand is re-optimized with the standard optimizer; the
 *    reported revenue is Σ p(g,s) over assigned slots at priced loads.
 */

import type { BookingRequest, SlotAssignment } from './types';
import {
  GATE_IDS,
  SLOTS_PER_GATE,
  slotIndexToStart,
  startToSlotIndex,
  capacityForGate,
  DAY_START_MIN,
  DAY_END_MIN,
} from './types';
import { makeRng } from './data';
import { optimizeSlots, loadBySlot } from './optimizer';

export interface PricingOptions {
  seed?: number;
  /** Base slot price in $ (default 25). */
  basePrice?: number;
  /** Load surcharge coefficient σ (default 0.5). */
  surcharge?: number;
  /** Max schedule shift a carrier will consider, minutes (default 120). */
  maxShiftMin?: number;
  /** Optimizer method for the priced re-optimization. */
  method?: 'greedy' | 'annealed';
}

export interface PricingResult {
  basePrice: number;
  surcharge: number;
  basePeakLoad: number;
  pricedPeakLoad: number;
  peakReductionPct: number;
  /** Σ slot prices over assigned slots ($). */
  revenue: number;
  /** Trucks whose preferred window moved. */
  shiftedCount: number;
  /** Mean absolute displacement of shifted trucks (minutes). */
  avgDisplacementMin: number;
  /** Mean slot price actually paid ($). */
  avgPricePaid: number;
  /** Demand with shifted preferred windows. */
  shiftedRequests: BookingRequest[];
  /** Base (unpriced) and priced plans. */
  basePlan: SlotAssignment[];
  pricedPlan: SlotAssignment[];
  /** Slot price table (per gate, per slot index). */
  prices: number[][];
}

const PEAK_START = 420; // 07:00
const PEAK_END = 660; // 11:00
const SHOULDER_1_END = 840; // 14:00
const SHOULDER_2_START = 1020; // 17:00
const SHOULDER_2_END = 1140; // 19:00

/** Time-of-day price tier for a slot start (minutes since midnight). */
export function priceTier(slotStart: number): number {
  if (slotStart >= PEAK_START && slotStart < PEAK_END) return 1.8;
  if (
    (slotStart >= PEAK_END && slotStart < SHOULDER_1_END) ||
    (slotStart >= SHOULDER_2_START && slotStart < SHOULDER_2_END)
  ) {
    return 1.15;
  }
  return 0.6;
}

export function slotPrice(
  slotStart: number,
  loadFactor: number,
  basePrice: number,
  surcharge: number,
): number {
  return basePrice * priceTier(slotStart) * (1 + surcharge * loadFactor);
}

export function applyCongestionPricing(
  requests: BookingRequest[],
  opts: PricingOptions = {},
): PricingResult {
  const seed = opts.seed ?? 42;
  const basePrice = opts.basePrice ?? 25;
  const surcharge = opts.surcharge ?? 0.5;
  const maxShiftMin = opts.maxShiftMin ?? 120;
  const method = opts.method ?? 'greedy';

  // Base (unpriced) plan → load factors → slot prices.
  const basePlan = optimizeSlots(requests, {
    seed,
    method,
    overbook: false,
  });
  const baseLoads = loadBySlot(basePlan);
  const prices: number[][] = GATE_IDS.map((g) => {
    const row: number[] = [];
    for (let s = 0; s < SLOTS_PER_GATE; s++) {
      const slotStart = slotIndexToStart(s);
      const load = baseLoads.get(`${g}:${slotStart}`) ?? 0;
      const loadFactor = load / capacityForGate(g);
      row.push(slotPrice(slotStart, loadFactor, basePrice, surcharge));
    }
    return row;
  });
  const basePeakLoad = Math.max(
    0,
    ...[...baseLoads.values()],
  );

  // Carrier response: re-centre preferred windows by generalized cost.
  const rng = makeRng(seed + 999);
  let shiftedCount = 0;
  let displacementSum = 0;
  const shiftedRequests: BookingRequest[] = requests.map((req) => {
    const vot = 30 + 90 * rng(); // synthetic value of time, $30–120/h
    const windowLen = req.preferredEnd - req.preferredStart;
    const lo = Math.max(
      0,
      startToSlotIndex(req.preferredStart - maxShiftMin),
    );
    const hi = Math.min(
      SLOTS_PER_GATE - 1,
      startToSlotIndex(req.preferredEnd + maxShiftMin),
    );
    let bestSlot = startToSlotIndex(req.preferredStart);
    let bestCost = Infinity;
    for (let s = lo; s <= hi; s++) {
      const slotStart = slotIndexToStart(s);
      // Cheapest gate price at this slot (carriers see the slot price,
      // not yet knowing which gate they will get).
      const p = Math.min(...GATE_IDS.map((g) => prices[g][s]));
      // Displacement from the NEAREST EDGE of the preferred window:
      // 0 inside the window, growing linearly outside it.
      const displacement =
        slotStart < req.preferredStart
          ? req.preferredStart - slotStart
          : slotStart > req.preferredEnd
            ? slotStart - req.preferredEnd
            : 0;
      const genCost = p + (vot * displacement) / 60;
      if (genCost < bestCost - 1e-9) {
        bestCost = genCost;
        bestSlot = s;
      }
    }
    const newStart = Math.min(
      slotIndexToStart(bestSlot),
      DAY_END_MIN - windowLen,
    );
    const newEnd = newStart + windowLen;
    const windowShift = Math.abs(newStart - req.preferredStart);
    if (windowShift > 0) {
      shiftedCount += 1;
      displacementSum += windowShift;
    }
    return { ...req, preferredStart: newStart, preferredEnd: newEnd };
  });

  // Re-optimize on shifted demand; revenue at priced loads.
  const pricedPlan = optimizeSlots(shiftedRequests, {
    seed,
    method,
    overbook: false,
  });
  const pricedLoads = loadBySlot(pricedPlan);
  const pricedPeakLoad = Math.max(0, ...[...pricedLoads.values()]);
  let revenue = 0;
  let priceSum = 0;
  for (const a of pricedPlan) {
    const s = startToSlotIndex(a.slotStart);
    const p = prices[a.gate][s];
    revenue += p;
    priceSum += p;
  }
  const peakReductionPct =
    basePeakLoad > 0
      ? ((basePeakLoad - pricedPeakLoad) / basePeakLoad) * 100
      : 0;

  return {
    basePrice,
    surcharge,
    basePeakLoad,
    pricedPeakLoad,
    peakReductionPct: Math.round(peakReductionPct * 10) / 10,
    revenue: Math.round(revenue * 100) / 100,
    shiftedCount,
    avgDisplacementMin:
      shiftedCount > 0
        ? Math.round((displacementSum / shiftedCount) * 10) / 10
        : 0,
    avgPricePaid:
      pricedPlan.length > 0
        ? Math.round((priceSum / pricedPlan.length) * 100) / 100
        : 0,
    shiftedRequests,
    basePlan,
    pricedPlan,
    prices,
  };
}
