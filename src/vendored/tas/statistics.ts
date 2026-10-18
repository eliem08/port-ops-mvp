/**
 * lib/statistics.ts
 *
 * Statistical rigor for the week simulation: warm-up handling, batch-means
 * confidence intervals, and a Little's Law internal-consistency check.
 *
 * What these are — and are not:
 *  • Warm-up: the first W minutes of the day are discarded from statistics,
 *    because the system starts empty (a cold start that is not steady
 *    state). Standard discrete-event practice.
 *  • Batch means: the post-warm-up observation window is split into b
 *    equal batches; batch means are treated as ~i.i.d. normal (justified
 *    when batches are long relative to autocorrelation), giving a
 *    Student-t confidence interval on the reported KPI.
 *  • Little's Law (L = λ·W): a THEOREM — it must hold for any stable
 *    queueing system. The check therefore validates the simulator's
 *    BOOKKEEPING (truck conservation, consistent measurement), not the
 *    physics. L is measured independently by time-sampling the queue
 *    length; λ·W is measured independently from per-truck arrival/wait
 *    records.
 *
 * Discrete-time bias correction (derived, not fudged): the simulator
 * samples the queue at 5-minute step boundaries, AFTER arrivals but
 * BEFORE service. A truck arriving at a_i joins at the first step
 * boundary j_i ≥ a_i, and is counted in every sample up to and including
 * its service step k_i — i.e. in (k_i − j_i + 1) samples — while its true
 * wait is (t_{k_i} − a_i). Summing over trucks:
 *     Σ samples = Σ (k_i − j_i + 1) = (Σ wait_i − Σ phase_i)/STEP + N,
 * where phase_i = (t_{j_i} − a_i) ∈ [0, STEP) is the arrival's offset
 * within its step. Dividing by the number of steps gives the exact
 * discrete-time identity:
 *     L = λ · (W − meanPhase + STEP).
 * The check therefore compares L against λ·(W − meanPhase + STEP), with
 * meanPhase MEASURED from the arrival records (not assumed). Residual
 * disagreement comes only from window-boundary trucks (queued at window
 * start, or still queued at simulation end) — kept small by the warm-up
 * and the 120-minute post-close drain.
 */

import { DAY_START_MIN, DAY_END_MIN } from './types';
import { makeRng, generateDayRequests } from './data';
import { optimizeSlots, baselineAssign } from './optimizer';
import {
  buildArrivalStreams,
  simulateQueues,
  SIM_WINDOW,
  SIM_STEP,
} from './simulation';

/** Two-sided 97.5% Student-t critical values, df 1..30; 1.96 beyond. */
const T_975: Record<number, number> = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
  6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
  11: 2.201, 12: 2.179, 13: 2.16, 14: 2.145, 15: 2.131,
  16: 2.12, 17: 2.11, 18: 2.101, 19: 2.093, 20: 2.086,
  21: 2.08, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.06,
  26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042,
};

export function tCritical975(df: number): number {
  if (df <= 0) return NaN;
  if (df <= 30) return T_975[Math.trunc(df)] ?? 1.96;
  return 1.96;
}

export interface BatchMeansResult {
  mean: number;
  low: number;
  high: number;
  halfWidth: number;
  batchMeans: number[];
  batches: number;
  /** Standard deviation of the batch means. */
  stdDev: number;
}

/**
 * Batch-means confidence interval for the mean of a time series.
 * Splits `values` into `batches` equal batches (remainder dropped),
 * computes batch means, and returns mean ± t_{b−1,0.975}·s/√b.
 */
export function batchMeansCI(values: number[], batches = 10): BatchMeansResult {
  const b = Math.max(2, Math.trunc(batches));
  const n = Math.floor(values.length / b) * b;
  if (n < b * 2) {
    const mean = values.length > 0
      ? values.reduce((s, v) => s + v, 0) / values.length
      : 0;
    return {
      mean,
      low: mean,
      high: mean,
      halfWidth: 0,
      batchMeans: [],
      batches: 0,
      stdDev: 0,
    };
  }
  const size = Math.floor(n / b);
  const batchMeans: number[] = [];
  for (let i = 0; i < b; i++) {
    const chunk = values.slice(i * size, (i + 1) * size);
    batchMeans.push(chunk.reduce((s, v) => s + v, 0) / chunk.length);
  }
  const mean = batchMeans.reduce((s, v) => s + v, 0) / b;
  const variance =
    batchMeans.reduce((s, v) => s + (v - mean) ** 2, 0) / (b - 1);
  const stdDev = Math.sqrt(variance);
  const halfWidth = tCritical975(b - 1) * stdDev / Math.sqrt(b);
  return {
    mean,
    low: mean - halfWidth,
    high: mean + halfWidth,
    halfWidth,
    batchMeans,
    batches: b,
    stdDev,
  };
}

export interface LittlesLawResult {
  /** Time-average number in queue (measured by time-sampling). */
  avgNumberInSystem: number;
  /** Arrival rate to the queue (trucks per minute). */
  arrivalRate: number;
  /** Average waiting time in queue (minutes, per-truck records). */
  avgWait: number;
  /** λ·(W − meanPhase + STEP) — discrete-time Little's Law prediction of L. */
  predicted: number;
  /** Mean arrival phase offset within its 5-minute step (minutes). */
  meanPhase: number;
  /** |L − predicted| / max(predicted, ε). */
  relativeError: number;
  /** Passes if relativeError ≤ tolerance. */
  passes: boolean;
  tolerance: number;
  /** Trucks counted in the window (arrived in window, served before end). */
  trucksCounted: number;
}

/**
 * Little's Law check from independently measured quantities, with the
 * derived discrete-time bias correction (see module header).
 */
export function littlesLawCheck(
  avgNumberInSystem: number,
  arrivalRate: number,
  avgWait: number,
  meanPhase: number,
  stepMin: number,
  tolerance = 0.2,
): Omit<LittlesLawResult, 'trucksCounted'> {
  const predicted = arrivalRate * (avgWait - meanPhase + stepMin);
  const denom = Math.max(predicted, 1e-9);
  const relativeError = Math.abs(avgNumberInSystem - predicted) / denom;
  return {
    avgNumberInSystem,
    arrivalRate,
    avgWait,
    predicted,
    meanPhase,
    relativeError,
    passes: relativeError <= tolerance,
    tolerance,
  };
}

export interface ValidationOptions {
  /** Warm-up minutes discarded from the start of the operating day. */
  warmUpMin?: number;
  /** Number of batch-means batches (default 10). */
  batches?: number;
  /** Little's Law tolerance (default 0.20). */
  tolerance?: number;
  /** Optimizer method for the TAS world (default 'greedy'). */
  method?: 'greedy' | 'annealed';
}

export interface ValidationResult {
  nTrucks: number;
  seed: number;
  warmUpMin: number;
  /** Observation window [start, end] in minutes since midnight. */
  window: { start: number; end: number };
  littlesLaw: LittlesLawResult;
  /** Batch-means CI on the time-sampled queue length (post warm-up). */
  queueBatchMeans: BatchMeansResult;
  /** Batch-means CI on per-truck waits (post warm-up arrivals). */
  waitBatchMeans: BatchMeansResult;
  /** Mean queue length over the window (point estimate). */
  meanQueue: number;
  /** Mean wait over the window (point estimate). */
  avgWait: number;
}

/**
 * Validate one simulated TAS day: run the optimized world with
 * instrumentation, discard the warm-up, and compute (a) batch-means CIs on
 * queue length and wait, (b) the Little's Law bookkeeping check.
 */
export function validateDay(
  nTrucks = 220,
  seed = 42,
  opts: ValidationOptions = {},
): ValidationResult {
  const warmUpMin = opts.warmUpMin ?? 60;
  const batches = opts.batches ?? 10;
  const tolerance = opts.tolerance ?? 0.2;
  const rng = makeRng(seed);
  const requests = generateDayRequests(nTrucks, seed);
  const optAssignments = optimizeSlots(requests, {
    seed,
    overbook: true,
    method: opts.method ?? 'greedy',
  });
  const baseAssignments = baselineAssign(requests);
  const { optArrivals } = buildArrivalStreams(
    requests,
    optAssignments,
    baseAssignments,
    rng,
  );

  const sim = simulateQueues(optArrivals, { instrument: true });
  const inst = sim.instrumented!;

  const windowStart = DAY_START_MIN + warmUpMin;
  const windowEnd = SIM_WINDOW.end;
  const windowLen = windowEnd - windowStart;

  // L: time-average queue length over the window (independent measurement 1).
  const samplesInWindow = inst.samples.filter(
    (s) => s.t >= windowStart && s.t <= windowEnd,
  );
  const meanQueue =
    samplesInWindow.reduce((sum, s) => sum + s.queue, 0) /
    Math.max(1, samplesInWindow.length);

  // λ, W: arrivals in window + waits of trucks that arrived in window and
  // were served before the simulation end (independent measurement 2).
  const arrivalsInWindow = inst.arrivals.filter(
    (t) => t >= windowStart && t <= windowEnd,
  );
  const waitsInWindow = inst.waits.filter(
    (w) => w.arrivedAt >= windowStart && w.arrivedAt <= windowEnd,
  );
  const lambda = arrivalsInWindow.length / windowLen;
  const avgWait =
    waitsInWindow.reduce((sum, w) => sum + (w.servedAt - w.arrivedAt), 0) /
    Math.max(1, waitsInWindow.length);

  // Mean arrival phase: offset of each arrival within its 5-minute step.
  // Measured from the records (arrivals are continuous, so this is ~STEP/2).
  const meanPhase =
    waitsInWindow.reduce((sum, w) => {
      const joinStep =
        SIM_WINDOW.start +
        Math.ceil((w.arrivedAt - SIM_WINDOW.start) / SIM_STEP) * SIM_STEP;
      return sum + (joinStep - w.arrivedAt);
    }, 0) / Math.max(1, waitsInWindow.length);

  const ll = littlesLawCheck(meanQueue, lambda, avgWait, meanPhase, SIM_STEP, tolerance);

  // Batch means: queue samples in window order; waits in arrival order.
  const queueBatchMeans = batchMeansCI(
    samplesInWindow.map((s) => s.queue),
    batches,
  );
  const waitBatchMeans = batchMeansCI(
    waitsInWindow.map((w) => w.servedAt - w.arrivedAt),
    batches,
  );

  return {
    nTrucks,
    seed,
    warmUpMin,
    window: { start: windowStart, end: windowEnd },
    littlesLaw: { ...ll, trucksCounted: waitsInWindow.length },
    queueBatchMeans,
    waitBatchMeans,
    meanQueue: Math.round(meanQueue * 100) / 100,
    avgWait: Math.round(avgWait * 100) / 100,
  };
}
