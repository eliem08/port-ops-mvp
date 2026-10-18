/**
 * lib/simulation.ts
 *
 * Day-level discrete-event simulation comparing two worlds:
 *
 *   baseline  — no appointment system. Trucks arrive around their preferred
 *               time with wide jitter, plus a 12% unannounced walk-in surge
 *               at the morning peak. Nobody is turned away; queues explode.
 *   optimized — TAS. Trucks arrive inside a tight window around their
 *               assigned slot; modeled no-shows (lib/predictor) never arrive.
 *               The baseline world sees the SAME no-show set (common random
 *               numbers), so the comparison isolates scheduling, not demand.
 *               Only the baseline gets the unannounced walk-in surge.
 *
 * Queue model (deliberately simple, fully deterministic per seed): 5-minute
 * time steps, one FIFO queue per gate. Each gate serves trucks at its own
 * rate (express 4 min, standard 5 min, inspection 8 min) via a service-
 * credit accumulator: a gate serves a truck once it has banked a full
 * service interval. Enough to reproduce the congestion curve without
 * pretending to be a traffic microsimulator.
 *
 * simulateWeek runs one day per horizon day (each day seeded
 * seed + day * 101) and aggregates the totals.
 */

import type {
  BookingRequest,
  SlotAssignment,
  DayMetrics,
  ScenarioResult,
  WeekResult,
  HorizonSummary,
  OptimizerMethod,
} from './types';
import {
  GATE_IDS,
  DAY_START_MIN,
  DAY_END_MIN,
  IDLE_FUEL_L_PER_H,
  CO2_KG_PER_L,
  minutesToHHMM,
  serviceMinForGate,
  HORIZON_DAYS,
} from './types';
import { makeRng, generateDayRequests } from './data';
import { optimizeSlots, baselineAssign } from './optimizer';
import { noShowProbability } from './predictor';

const STEP_MIN = 5;

/** Time-step size (minutes), exported for the validation module's phase correction. */
export const SIM_STEP = STEP_MIN;
const OPT_JITTER = 12; // optimized arrivals: ±12 min around slot
const BASE_JITTER_EARLY = -30; // baseline arrivals: -30..
const BASE_JITTER_LATE = 90; // ..+90 min around preferred start
const BASELINE_SURGE_RATE = 0.12; // unannounced walk-ins at morning peak
const PEAK_WINDOW_MIN = 180; // first 3h of the operating day
const SERIES_EVERY_MIN = 30;

const SIM_START = DAY_START_MIN - 60;
const SIM_END = DAY_END_MIN + 120;

/** Simulation window bounds, exported for the validation module. */
export const SIM_WINDOW = { start: SIM_START, end: SIM_END } as const;

export interface Arrival {
  time: number;
  gate: number;
}

export interface QueueInstrumented {
  /** Total queue length sampled at every 5-minute step. */
  samples: Array<{ t: number; queue: number }>;
  /** Per-truck wait records (only trucks served before SIM_END). */
  waits: Array<{ arrivedAt: number; servedAt: number; gate: number }>;
  /** All arrival times (including trucks stranded at SIM_END). */
  arrivals: number[];
}

export function simulateQueues(
  arrivals: Arrival[],
  opts: { instrument?: boolean } = {},
): {
  maxQueue: number;
  avgWaitMin: number;
  served: number;
  utilization: [number, number, number];
  queueSeries: number[];
  seriesTimes: number[];
  instrumented?: QueueInstrumented;
} {
  const sorted = [...arrivals].sort((a, b) => a.time - b.time);
  const queues: number[][] = GATE_IDS.map(() => []); // arrival times
  // Service credit per gate: a gate serves a truck once credit >= 1.
  // Credit grows by STEP_MIN / serviceMin per step, so faster gates serve
  // more trucks per step on average.
  const credit = GATE_IDS.map((g) => 0);
  const busySteps = [0, 0, 0];
  let totalSteps = 0;
  let maxQueue = 0;
  let waitSum = 0;
  let served = 0;
  const queueSeries: number[] = [];
  const seriesTimes: number[] = [];

  let ai = 0;
  const samples: Array<{ t: number; queue: number }> = [];
  const waits: QueueInstrumented['waits'] = [];
  const arrivalTimes: number[] = arrivals.map((a) => a.time);
  for (let t = SIM_START; t <= SIM_END; t += STEP_MIN) {
    totalSteps += 1;
    while (ai < sorted.length && sorted[ai].time <= t) {
      queues[sorted[ai].gate].push(sorted[ai].time);
      ai += 1;
    }
    let q = 0;
    for (const g of GATE_IDS) {
      q += queues[g].length;
      credit[g] += STEP_MIN / serviceMinForGate(g);
      let servedThisStep = false;
      while (credit[g] >= 1 && queues[g].length > 0) {
        credit[g] -= 1;
        const arrivedAt = queues[g].shift()!;
        waitSum += Math.max(0, t - arrivedAt);
        if (opts.instrument) {
          waits.push({ arrivedAt, servedAt: t, gate: g });
        }
        served += 1;
        servedThisStep = true;
      }
      if (servedThisStep) busySteps[g] += 1;
    }
    if (q > maxQueue) maxQueue = q;
    if ((t - SIM_START) % SERIES_EVERY_MIN === 0) {
      queueSeries.push(q);
      seriesTimes.push(t);
    }
    if (opts.instrument) samples.push({ t, queue: q });
  }
  // Trucks still queued at SIM_END never got served; charge them the
  // remaining wait estimate so avgWait reflects the meltdown honestly.
  let stranded = 0;
  for (const g of GATE_IDS) {
    for (const arrivedAt of queues[g]) {
      waitSum += Math.max(0, SIM_END - arrivedAt);
      stranded += 1;
    }
  }

  const denom = Math.max(1, served + stranded);
  return {
    maxQueue,
    avgWaitMin: waitSum / denom,
    served,
    utilization: [
      busySteps[0] / totalSteps,
      busySteps[1] / totalSteps,
      busySteps[2] / totalSteps,
    ],
    queueSeries,
    seriesTimes,
    instrumented: opts.instrument
      ? { samples, waits, arrivals: arrivalTimes }
      : undefined,
  };
}

/**
 * Build the two arrival streams (TAS world + status-quo world) for a set of
 * requests. Extracted from simulateDay so the validation module can reuse
 * the exact same arrival process instead of re-implementing it.
 *
 * COMMON RANDOM NUMBERS (paired comparison): one no-show draw per truck,
 * shared by BOTH worlds. A truck that no-shows does not arrive in either
 * world. Previously the TAS world filtered no-shows but the baseline world
 * did not — so the TAS-vs-baseline comparison was confounded by different
 * realized demand (~91 arrivals vs ~246). Now both worlds see the same
 * realized demand and the comparison isolates the SCHEDULING effect, with
 * lower estimator variance (standard variance-reduction practice). The
 * baseline world still gets its unannounced walk-in surge — that asymmetry
 * is the point (TAS eliminates walk-ins).
 */
export function buildArrivalStreams(
  requests: BookingRequest[],
  optAssignments: SlotAssignment[],
  baseAssignments: SlotAssignment[],
  rng: () => number,
): { optArrivals: Arrival[]; baseArrivals: Arrival[]; surge: number } {
  const byId = new Map(requests.map((r) => [r.id, r]));

  // One no-show draw per truck, shared by both worlds. p uses the
  // PREFERRED window (the only slot information both worlds share).
  const showsUp = new Map<string, boolean>();
  for (const r of requests) {
    const p = noShowProbability({
      leadTimeHours: r.leadTimeHours,
      driverNoShowRate: r.driverNoShowRate,
      slotStartMin: r.preferredStart,
      cargo: r.cargo,
    });
    showsUp.set(r.id, rng() >= p);
  }

  // --- Optimized arrivals: tight around the assigned slot, minus no-shows.
  const optArrivals: Arrival[] = [];
  for (const a of optAssignments) {
    const req = byId.get(a.requestId);
    if (!req) continue;
    if (!showsUp.get(req.id)) continue; // no-show: never arrives
    const jitter = (rng() * 2 - 1) * OPT_JITTER;
    optArrivals.push({ time: a.slotStart + jitter, gate: a.gate });
  }

  // --- Baseline arrivals: preferred time ± wide jitter + walk-in surge.
  // Same no-show set as the TAS world (paired comparison).
  const baseArrivals: Arrival[] = [];
  for (const a of baseAssignments) {
    const req = byId.get(a.requestId);
    if (!req) continue;
    if (!showsUp.get(req.id)) continue; // no-show: never arrives
    const jitter =
      BASE_JITTER_EARLY + rng() * (BASE_JITTER_LATE - BASE_JITTER_EARLY);
    baseArrivals.push({ time: req.preferredStart + jitter, gate: a.gate });
  }
  const surge = Math.round(requests.length * BASELINE_SURGE_RATE);
  for (let i = 0; i < surge; i++) {
    baseArrivals.push({
      time: DAY_START_MIN + rng() * PEAK_WINDOW_MIN,
      gate: GATE_IDS[Math.floor(rng() * GATE_IDS.length)],
    });
  }

  return { optArrivals, baseArrivals, surge };
}

/**
 * Simulate one operating day with `nTrucks` of demand.
 * Deterministic for a given (seed, method) pair.
 */
export function simulateDay(
  nTrucks = 220,
  seed = 42,
  opts: { method?: OptimizerMethod; day?: number } = {},
): ScenarioResult {
  const rng = makeRng(seed);
  const requests = generateDayRequests(nTrucks, seed);

  const optAssignments = optimizeSlots(requests, {
    seed,
    overbook: true,
    method: opts.method ?? 'greedy',
  });
  const baseAssignments = baselineAssign(requests);
  const { optArrivals, baseArrivals, surge } = buildArrivalStreams(
    requests,
    optAssignments,
    baseAssignments,
    rng,
  );

  const opt = simulateQueues(optArrivals);
  const base = simulateQueues(baseArrivals);

  const co2 = (avgWaitMin: number, trucks: number) =>
    ((trucks * avgWaitMin * IDLE_FUEL_L_PER_H) / 60) * CO2_KG_PER_L / 1000;

  const operatingHours = (DAY_END_MIN - DAY_START_MIN) / 60;

  const toMetrics = (
    s: ReturnType<typeof simulateQueues>,
    totalTrucks: number,
    rescheduleRate: number,
  ): DayMetrics => ({
    maxQueueLength: s.maxQueue,
    avgWaitMin: Math.round(s.avgWaitMin * 10) / 10,
    totalTrucks,
    servedTrucks: s.served,
    rescheduleRate: Math.round(rescheduleRate * 1000) / 1000,
    gateUtilization: [
      Math.round(s.utilization[0] * 1000) / 1000,
      Math.round(s.utilization[1] * 1000) / 1000,
      Math.round(s.utilization[2] * 1000) / 1000,
    ],
    co2Tonnes: Math.round(co2(s.avgWaitMin, totalTrucks) * 1000) / 1000,
    throughputPerHour: Math.round((s.served / operatingHours) * 10) / 10,
    queueSeries: s.seriesTimes.map((t, i) => ({
      t: minutesToHHMM(t),
      baseline: 0, // filled by caller
      optimized: 0,
    })),
    day: opts.day ?? 0,
    method: opts.method ?? 'greedy',
  });

  const bMetrics = toMetrics(base, nTrucks + surge, 0);
  const oMetrics = toMetrics(
    opt,
    nTrucks,
    optAssignments.filter((a) => a.rescheduled).length /
      Math.max(1, optAssignments.length),
  );

  // Merge the two queue curves into one series for the chart.
  const queueSeries = base.seriesTimes.map((t, i) => ({
    t: minutesToHHMM(t),
    baseline: base.queueSeries[i] ?? 0,
    optimized: opt.queueSeries[i] ?? 0,
  }));
  bMetrics.queueSeries = queueSeries;
  oMetrics.queueSeries = queueSeries;

  return {
    baseline: bMetrics,
    optimized: oMetrics,
    params: { trucks: nTrucks, seed },
  };
}

/**
 * Simulate a whole rolling horizon: one day per horizon day, each seeded
 * seed + day * 101 (same offset scheme as generateWeekRequests), then
 * aggregate the totals. Deterministic for a given (trucks, seed, method).
 */
export function simulateWeek(
  nTrucksPerDay = 220,
  seed = 42,
  days: number = HORIZON_DAYS,
  method: OptimizerMethod = 'greedy',
): WeekResult {
  const dayResults: ScenarioResult[] = [];
  for (let day = 0; day < days; day += 1) {
    dayResults.push(
      simulateDay(nTrucksPerDay, seed + day * 101, { method, day }),
    );
  }

  const totalTrucks = dayResults.reduce((s, r) => s + r.optimized.totalTrucks, 0);
  const totalCo2Baseline = dayResults.reduce((s, r) => s + r.baseline.co2Tonnes, 0);
  const totalCo2Optimized = dayResults.reduce((s, r) => s + r.optimized.co2Tonnes, 0);
  const waitBaseline =
    dayResults.reduce((s, r) => s + r.baseline.avgWaitMin * r.baseline.totalTrucks, 0) /
    Math.max(1, dayResults.reduce((s, r) => s + r.baseline.totalTrucks, 0));
  const waitOptimized =
    dayResults.reduce((s, r) => s + r.optimized.avgWaitMin * r.optimized.totalTrucks, 0) /
    Math.max(1, totalTrucks);
  const rescheduled = dayResults.reduce(
    (s, r) => s + r.optimized.rescheduleRate * r.optimized.totalTrucks,
    0,
  );

  const horizon: HorizonSummary = {
    days,
    totalTrucks,
    totalCo2Baseline: Math.round(totalCo2Baseline * 1000) / 1000,
    totalCo2Optimized: Math.round(totalCo2Optimized * 1000) / 1000,
    co2SavedTonnes:
      Math.round((totalCo2Baseline - totalCo2Optimized) * 1000) / 1000,
    avgWaitBaseline: Math.round(waitBaseline * 10) / 10,
    avgWaitOptimized: Math.round(waitOptimized * 10) / 10,
    maxQueueBaseline: Math.max(...dayResults.map((r) => r.baseline.maxQueueLength)),
    maxQueueOptimized: Math.max(...dayResults.map((r) => r.optimized.maxQueueLength)),
    rescheduleRate: Math.round((rescheduled / Math.max(1, totalTrucks)) * 1000) / 1000,
  };

  return { days: dayResults, horizon };
}
