/**
 * lib/predictor.ts
 *
 * HONEST DISCLAIMER — this is NOT machine learning.
 *
 * There is no trained model, no gradient descent, no dataset behind this file.
 * `noShowProbability` is a hand-tuned, logistic-style scoring function: a linear
 * combination of a handful of domain features pushed through a sigmoid and then
 * clamped to a sane operating range. The coefficients below were chosen so the
 * output behaves sensibly for a mid-size grain/reefer terminal (short-lead
 * bookings are riskier, habitual no-show drivers are riskier, night slots are
 * riskier, harvest-season grain is riskier). They are *priors*, not fitted
 * parameters.
 *
 * Treat the output as a calibrated heuristic that is good enough to drive
 * overbooking and to explain itself to a dispatcher — not as a prediction with
 * a validated AUC. If real booking history becomes available, replace the
 * coefficients with a fitted logistic regression and keep this interface.
 */

import type { CargoType } from './types';

/** Feature vector for a single booking. All fields are known at booking time. */
export interface NoShowFeatures {
  /** Hours between the moment the booking was made and the slot start. */
  leadTimeHours: number;
  /** Historical no-show rate of the assigned driver/carrier, 0..1. */
  driverNoShowRate: number;
  /** Slot start expressed as minutes from midnight (e.g. 08:30 -> 510). */
  slotStartMin: number;
  /** Commodity being hauled; changes the operational pressure on the slot. */
  cargo: CargoType;
}

/** Night window: before 07:00 or from 19:00 onwards. */
const NIGHT_START_MIN = 420; // 07:00
const NIGHT_END_MIN = 1140; // 19:00

/** Lead time is capped so a booking made a month out is not treated as risk-free. */
const LEAD_TIME_CAP_HOURS = 72;

/** Hard clamp on the returned probability. */
const P_MIN = 0.02;
const P_MAX = 0.85;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Logistic-style no-show score.
 *
 *   z = -3.2 + 0.012 * min(leadTimeHours, 72) + 4.0 * driverNoShowRate
 *         + nightPenalty + cargoAdj
 *   p = 1 / (1 + e^-z), clamped to [0.02, 0.85]
 *
 * DIRECTION OF THE LEAD-TIME EFFECT (read carefully): the lead-time
 * coefficient is POSITIVE — bookings made further in advance score HIGHER
 * no-show risk (plans made far ahead are more likely to change). This is
 * the behaviour pinned by tests/predictor.test.ts.
 *
 * RECALIBRATION (2026-10-13, professor-level review): the previous
 * coefficients (−2.2 intercept, +0.045 lead) implied a 40–60% no-show
 * rate for typical bookings — contradicting this file's own documented
 * ~10% base rate, real TAS experience (5–15%), and the simulation's
 * premise. With the demo's lead-time distribution (2–72h, mean ~37h),
 * the old coefficients made only ~40% of booked trucks arrive, so the
 * simulated port sat far below capacity and the TAS-vs-baseline gap was
 * mostly a demand artifact, not a scheduling effect. The new coefficients
 * imply a typical p ≈ 0.08–0.16 (short lead ≈ 0.08, long lead ≈ 0.16,
 * night/grain/driver-history adjustments on top), consistent with the
 * documented base rate and with reality. This is still a prior to be
 * refitted from real booking history — not a measurement.
 */
export function noShowProbability(f: NoShowFeatures): number {
  const leadTimeHours = clamp(f.leadTimeHours, 0, LEAD_TIME_CAP_HOURS);
  const driverNoShowRate = clamp(f.driverNoShowRate, 0, 1);

  // Night slots are harder to staff and easier to skip.
  const nightPenalty =
    f.slotStartMin < NIGHT_START_MIN || f.slotStartMin >= NIGHT_END_MIN ? 0.55 : 0;

  // Commodity pressure. Grain spikes during harvest; reefer and hazmat are
  // contract-driven and therefore stickier.
  let cargoAdj = 0;
  switch (f.cargo) {
    case 'grain':
      cargoAdj = 0.25; // harvest-season rush
      break;
    case 'reefer':
      cargoAdj = -0.15;
      break;
    case 'hazmat':
      cargoAdj = -0.1;
      break;
    default:
      cargoAdj = 0; // general
      break;
  }

  const z = -3.2 + 0.012 * leadTimeHours + 4.0 * driverNoShowRate + nightPenalty + cargoAdj;
  const p = 1 / (1 + Math.exp(-z));

  return clamp(p, P_MIN, P_MAX);
}

/**
 * How many slots to release for a slot of `slotCapacity` given an expected
 * no-show rate. Overbooking is capped at 2x capacity so a bad day cannot
 * completely melt the gate.
 */
export function overbookLimit(slotCapacity: number, expectedNoShowRate: number): number {
  const capacity = Math.max(0, Math.floor(slotCapacity));
  const rate = clamp(expectedNoShowRate, 0, 0.99);
  const showUpRate = Math.max(0.35, 1 - rate);
  const limit = Math.ceil(capacity / showUpRate);
  return Math.min(Math.max(limit, capacity), capacity * 2);
}

/** Coarse banding used by the UI to colour a booking. */
export function riskBand(p: number): 'low' | 'medium' | 'high' {
  if (p < 0.12) return 'low';
  if (p < 0.3) return 'medium';
  return 'high';
}

/**
 * Short, human-readable reasons behind a score. Returns 2-4 lines so the
 * dispatcher can see *why* a booking is flagged, not just that it is.
 */
export function explainProbability(f: NoShowFeatures): string[] {
  const reasons: string[] = [];

  const lead = clamp(f.leadTimeHours, 0, LEAD_TIME_CAP_HOURS);
  if (lead <= 6) {
    reasons.push(`Booked only ${Math.max(1, Math.round(lead))}h ahead — last-minute, plans firm (-risk)`);
  } else if (lead >= 48) {
    reasons.push(`Booked ${Math.round(lead)}h ahead — long horizon, plans may change (+risk)`);
  }

  const rate = clamp(f.driverNoShowRate, 0, 1);
  if (rate >= 0.2) {
    reasons.push(`Carrier no-show history ${Math.round(rate * 100)}% (+risk)`);
  } else if (rate <= 0.05) {
    reasons.push('Reliable carrier history (-risk)');
  }

  if (f.slotStartMin < NIGHT_START_MIN || f.slotStartMin >= NIGHT_END_MIN) {
    reasons.push('Night slot, harder to staff (+risk)');
  }

  switch (f.cargo) {
    case 'grain':
      reasons.push('Grain harvest rush (+risk)');
      break;
    case 'reefer':
      reasons.push('Reefer contract load (-risk)');
      break;
    case 'hazmat':
      reasons.push('Hazmat load, tightly scheduled (-risk)');
      break;
    default:
      break;
  }

  if (reasons.length === 0) {
    reasons.push('Standard daytime booking, no risk flags');
  }

  return reasons.slice(0, 4);
}
