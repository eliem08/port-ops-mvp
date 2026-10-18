/**
 * Phase C — validated run service: contracts → engine → output.
 *
 * `runScenario` is the single server-side entry point for scenario
 * runs. It validates the payload with the zod contracts FIRST
 * (via `loadSimulationInput` — version gate + schema), maps the
 * contract input onto the engine's `SimParams`, runs the Phase B
 * Monte Carlo scheme (baseSeed + replication, Student-t CIs on
 * replication-level observations), and returns a `SimulationOutput`.
 *
 * Idempotency: results are cached in memory keyed by
 * `${inputHash}:${idempotencyKey}`. An identical input hash plus an
 * identical idempotency key returns the cached record instead of
 * re-running. The cache is in-memory and unlabeled-bounded — labeled
 * DEMO-ONLY, like the audit store. Every real run and every cache hit
 * appends an audit event.
 *
 * The simulation core (engine, RNG, stats) is untouched: statistical
 * guarantees from Phase B (event ordering, seed reproducibility, CI
 * correctness) are preserved by construction — this module only
 * *calls* the audited primitives.
 */

import { runSimulation } from "./engine";
import { summarizeSamples } from "./montecarlo";
import { confidenceInterval } from "./stats";
import { DEFAULT_PARAMS } from "./scenarios";
import type { Kpis, SimParams } from "./types";
import { auditStore } from "./audit";
import {
  SIM_OUTPUT_CONTRACT_VERSION,
  assertValidOutput,
  inputHash,
  loadSimulationInput,
  type SimulationInput,
  type SimulationOutput,
} from "./contracts";

/* ------------------------------------------------------------------ */
/* Contract input → engine SimParams (documented mapping).             */
/* ------------------------------------------------------------------ */

/**
 * Map a validated SimulationInput onto the engine's SimParams.
 * Approximations are collected into `warnings` (returned alongside)
 * and surfaced on the output — never applied silently:
 *  - the engine's gate is lognormal: other families are approximated
 *    by a lognormal with the same mean and a matched/sensible sigma;
 *  - the engine's yard sigma is fixed at 0.4 and its berth is
 *    exponential: families are approximated by their mean;
 *  - contract resource kinds without an engine equivalent are ignored
 *    with a warning;
 *  - engine parameters the contract does not cover use illustrative
 *    DEFAULT_PARAMS values, listed in a single warning.
 */
export function inputToSimParams(input: SimulationInput): {
  params: SimParams;
  warnings: string[];
} {
  const warnings: string[] = [];
  const params: SimParams = {
    ...DEFAULT_PARAMS,
    disruptions: { ...DEFAULT_PARAMS.disruptions },
  };
  const defaulted: string[] = [];

  params.seed = input.seed;
  params.simHours = input.horizonHours;

  // --- Arrivals ---
  const ap = input.arrivalProcess;
  params.trucksPerDay = ap.ratePerHour * 24;
  params.morningPeakFactor = ap.peakFactor ?? 1;
  if (
    ap.peakWindowStartHour !== undefined &&
    ap.peakWindowEndHour !== undefined
  ) {
    params.peakWindow = [ap.peakWindowStartHour, ap.peakWindowEndHour];
  }
  params.appointmentSystem = ap.type === "scheduled";
  params.appointmentShare =
    ap.type === "scheduled" ? (ap.appointmentSharePct ?? 85) / 100 : 0;
  if (ap.type === "bunched") {
    warnings.push(
      "Arrival type 'bunched' is approximated by the engine's morning-peak profile; dedicated bunching windows are not modeled."
    );
  }
  if (ap.type === "scheduled" && ap.appointmentSharePct === undefined) {
    defaulted.push("appointmentSharePct=85%");
  }

  // --- Resources ---
  const findResource = (kind: string) =>
    input.resources.find((r) => r.kind === kind);
  const gateRes = findResource("gate-lane");
  const yardRes = findResource("yard-crane");
  const berthRes = findResource("berth");
  if (gateRes) params.numGates = gateRes.count;
  else defaulted.push("gate-lane count=3");
  if (yardRes) params.yardCranes = yardRes.count;
  else defaulted.push("yard-crane count=8");
  if (berthRes) params.numBerths = berthRes.count;
  else defaulted.push("berth count=3");
  for (const r of input.resources) {
    if (r.kind === "customs-desk") {
      warnings.push(
        `Resource "${r.id}" (kind 'customs-desk') has no engine equivalent and was ignored.`
      );
    }
  }

  // --- Service times ---
  const dist = input.serviceTimeDistributions;
  // Gate: engine samples lognormal(mean, sigma).
  params.gateServiceMeanMin = dist.gateServiceMin.meanMin;
  if (dist.gateServiceMin.family === "lognormal") {
    params.gateServiceSigma = dist.gateServiceMin.sigma ?? 0.5;
  } else {
    const fam = dist.gateServiceMin.family;
    const sigma =
      fam === "deterministic"
        ? 0.01
        : fam === "exponential"
          ? Math.sqrt(Math.log(2)) // CV=1 matched
          : uniformSigma(dist.gateServiceMin);
    params.gateServiceSigma = sigma;
    warnings.push(
      `Gate service family '${fam}' approximated as lognormal with the same mean (σ=${sigma.toFixed(3)}).`
    );
  }
  // Yard: engine sigma is fixed at 0.4 — only the mean is honored.
  params.yardHandleMeanMin = dist.yardHandlingMin.meanMin;
  if (dist.yardHandlingMin.family !== "lognormal") {
    warnings.push(
      `Yard handling family '${dist.yardHandlingMin.family}' approximated by its mean; the engine fixes yard variability at σ=0.4.`
    );
  }
  // Berth: engine samples exponential(mean).
  params.berthLoadMeanMin = dist.berthLoadingMin.meanMin;
  if (dist.berthLoadingMin.family !== "exponential") {
    warnings.push(
      `Berth loading family '${dist.berthLoadingMin.family}' approximated as exponential with the same mean.`
    );
  }

  // --- Cargo ---
  if (input.grainSharePct !== undefined) {
    params.grainShare = input.grainSharePct / 100;
  } else {
    defaulted.push("grainSharePct=25%");
  }
  if (input.grainPriority !== undefined) {
    params.grainPriority = input.grainPriority;
  } else {
    defaulted.push("grainPriority=false");
  }

  if (defaulted.length > 0) {
    warnings.push(
      `Engine parameters not covered by the contract used illustrative defaults: ${defaulted.join(", ")}.`
    );
  }

  return { params, warnings };
}

/** Lognormal sigma matching a uniform(min,max) distribution's CV. */
function uniformSigma(d: {
  meanMin: number;
  minMin?: number;
  maxMin?: number;
}): number {
  const lo = d.minMin ?? 0;
  const hi = d.maxMin ?? d.meanMin * 2;
  const mean = (lo + hi) / 2 || d.meanMin;
  const std = (hi - lo) / Math.sqrt(12);
  const cv = mean > 0 ? std / mean : 0.5;
  return Math.sqrt(Math.log(1 + cv * cv));
}

/* ------------------------------------------------------------------ */
/* Replication statistics.                                             */
/* ------------------------------------------------------------------ */

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Sanitize a KPI for the output contract; non-finite → 0 + warning. */
function finiteOrWarn(
  value: number,
  name: string,
  warnings: string[]
): number {
  if (Number.isFinite(value)) return value;
  warnings.push(
    `KPI '${name}' was non-finite (degenerate run) and reported as 0.`
  );
  return 0;
}

/* ------------------------------------------------------------------ */
/* Idempotency cache (in-memory, DEMO-ONLY).                            */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  output: SimulationOutput;
  runsExecuted: number;
}

const runCache = new Map<string, CacheEntry>();
let totalRunsExecuted = 0;
let totalCacheHits = 0;

function cacheKey(hash: string, idempotencyKey: string): string {
  return `${hash}:${idempotencyKey}`;
}

export interface RunCacheStats {
  cachedRecords: number;
  runsExecuted: number;
  cacheHits: number;
}

/** Observability for the DEMO-ONLY idempotency cache. */
export function getRunCacheStats(): RunCacheStats {
  return {
    cachedRecords: runCache.size,
    runsExecuted: totalRunsExecuted,
    cacheHits: totalCacheHits,
  };
}

/** Test/dev escape hatch for the DEMO-ONLY cache. */
export function clearRunCache(): void {
  runCache.clear();
  totalRunsExecuted = 0;
  totalCacheHits = 0;
}

/* ------------------------------------------------------------------ */
/* runScenario                                                         */
/* ------------------------------------------------------------------ */

export interface RunScenarioOptions {
  /**
   * Idempotency key supplied by the caller. Identical (inputHash,
   * idempotencyKey) pairs return the cached record instead of
   * re-running. Defaults to "default".
   */
  idempotencyKey?: string;
  /** Actor label for the audit trail. Defaults to "anonymous". */
  actor?: string;
}

/**
 * Validate-then-run: the single server-side scenario entry point.
 *
 * 1. `loadSimulationInput` validates the payload against the versioned
 *    contract FIRST — invalid input throws a structured SimError before
 *    any simulation work happens.
 * 2. Idempotency: a cached record for (inputHash, idempotencyKey) is
 *    returned as-is (deep-equal on repeat calls).
 * 3. Otherwise the Phase B Monte Carlo scheme runs (seeds
 *    baseSeed … baseSeed+replications−1) and the output is validated
 *    against the SimulationOutput contract before caching.
 * 4. Every outcome appends an audit event.
 */
export function runScenario(
  rawInput: unknown,
  options: RunScenarioOptions = {}
): SimulationOutput {
  // --- 1. Validate FIRST: never run on unvalidated input. ---
  const input: SimulationInput = loadSimulationInput(rawInput);
  const hash = inputHash(input);
  const idempotencyKey = options.idempotencyKey ?? "default";
  const actor = options.actor ?? "anonymous";
  const key = cacheKey(hash, idempotencyKey);

  const cached = runCache.get(key);
  if (cached) {
    totalCacheHits++;
    auditStore.record({
      eventType: "scenario.run.cache-hit",
      scenarioId: input.scenarioId,
      inputHash: hash,
      seed: input.seed,
      actor,
      atUtc: new Date().toISOString(),
      kpiSummary: summarizeForAudit(cached.output),
      idempotencyKey,
    });
    return cached.output;
  }

  // --- 2. Map + run the audited Monte Carlo scheme. ---
  const { params, warnings } = inputToSimParams(input);
  const runWarnings = [...warnings];

  const kpiSamples: Kpis[] = [];
  const p95WaitPerReplication: number[] = [];
  for (let i = 0; i < input.replications; i++) {
    const result = runSimulation(
      { ...params, seed: input.seed + i },
      undefined,
      { includeSeries: true } // wait samples needed for p95
    );
    kpiSamples.push(result.kpis);
    const waits = [...result.waitSamplesMin].sort((a, b) => a - b);
    p95WaitPerReplication.push(percentile(waits, 0.95));
  }
  totalRunsExecuted++;

  // --- 3. Build the contracted output. ---
  const summaries = summarizeSamples(kpiSamples);
  const kpis = {
    throughputTrucksPerHour: finiteOrWarn(
      summaries.throughputTrucksPerDay.mean / 24,
      "throughputTrucksPerHour",
      runWarnings
    ),
    throughputTeuPerHour: finiteOrWarn(
      summaries.throughputTeuPerDay.mean / 24,
      "throughputTeuPerDay",
      runWarnings
    ),
    meanWaitMin: finiteOrWarn(summaries.avgWaitMin.mean, "meanWaitMin", runWarnings),
    p95WaitMin: finiteOrWarn(
      mean(p95WaitPerReplication),
      "p95WaitMin",
      runWarnings
    ),
    maxQueueMean: finiteOrWarn(summaries.maxQueue.mean, "maxQueueMean", runWarnings),
    utilizationPct: {
      gate: finiteOrWarn(summaries.gateUtilization.mean * 100, "utilizationPct.gate", runWarnings),
      yard: finiteOrWarn(summaries.yardUtilization.mean * 100, "utilizationPct.yard", runWarnings),
      berth: finiteOrWarn(summaries.berthUtilization.mean * 100, "utilizationPct.berth", runWarnings),
    },
    co2Tonnes: finiteOrWarn(summaries.co2Tonnes.mean, "co2Tonnes", runWarnings),
    completedTrucksMean: finiteOrWarn(summaries.completedTrucks.mean, "completedTrucksMean", runWarnings),
    totalTrucksMean: finiteOrWarn(summaries.totalTrucks.mean, "totalTrucksMean", runWarnings),
  };

  // Confidence intervals on replication-level observations (Phase B
  // audit: Student-t, df = n−1).
  const ciOf = (
    metric: string,
    unit: string,
    values: number[]
  ) => {
    const ci = confidenceInterval(values, 0.95);
    return {
      metric,
      unit,
      method: "student-t" as const,
      confidenceLevel: 0.95 as const,
      replications: values.length,
      mean: ci.mean,
      low: ci.ciLow,
      high: ci.ciHigh,
    };
  };
  const confidenceIntervals = [
    ciOf("meanWaitMin", "minutes", kpiSamples.map((s) => s.avgWaitMin)),
    ciOf("p95WaitMin", "minutes", p95WaitPerReplication),
    ciOf(
      "throughputTrucksPerHour",
      "trucks/hour",
      kpiSamples.map((s) => s.throughputTrucksPerDay / 24)
    ),
    ciOf(
      "throughputTeuPerHour",
      "TEU/hour",
      kpiSamples.map((s) => s.throughputTeuPerDay / 24)
    ),
    ciOf(
      "utilizationGatePct",
      "percent",
      kpiSamples.map((s) => s.gateUtilization * 100)
    ),
  ];

  const assumptions = input.costAssumptions.map((c) => ({
    statement: `Cost assumption "${c.name}": ${c.amount} ${c.currency} per ${c.perUnit}${c.source ? ` (source: ${c.source})` : ""}.`,
    kind: c.kind,
  }));
  assumptions.push({
    statement:
      "Arrival, service-time, and cost inputs are scenario assumptions, not fitted to live port data; throughput and waits are model outputs.",
    kind: "illustrative" as const,
  });

  const output: SimulationOutput = {
    contractVersion: SIM_OUTPUT_CONTRACT_VERSION,
    scenarioId: input.scenarioId,
    inputHash: hash,
    completedAtUtc: new Date().toISOString(),
    kpis,
    confidenceIntervals,
    assumptions,
    warnings: runWarnings,
  };
  assertValidOutput(output);

  runCache.set(key, { output, runsExecuted: totalRunsExecuted });

  // --- 4. Audit the run. ---
  auditStore.record({
    eventType: "scenario.run.completed",
    scenarioId: input.scenarioId,
    inputHash: hash,
    seed: input.seed,
    actor,
    atUtc: output.completedAtUtc,
    kpiSummary: summarizeForAudit(output),
    idempotencyKey,
  });

  return output;
}

function summarizeForAudit(output: SimulationOutput) {
  return {
    throughputTrucksPerHour: output.kpis.throughputTrucksPerHour,
    meanWaitMin: output.kpis.meanWaitMin,
    p95WaitMin: output.kpis.p95WaitMin,
    utilizationGatePct: output.kpis.utilizationPct.gate,
  };
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
}
