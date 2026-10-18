/**
 * Phase C — versioned simulation I/O contracts (zod).
 *
 * Two contracts, each carrying its own `contractVersion`:
 *  - `SimulationInput`  (SIM_INPUT_CONTRACT_VERSION = "1.0.0")
 *  - `SimulationOutput` (SIM_OUTPUT_CONTRACT_VERSION = "1.0.0")
 *
 * Doctrine: minimum necessary. All durations/rates carry explicit units
 * in their field names (`ratePerHour`, `meanMin`, …) or a `unit` field;
 * numeric fields reject NaN/Infinity (not just out-of-range values);
 * objects are `.strict()` so unknown fields fail loudly instead of being
 * silently dropped or coerced.
 *
 * `loadSimulationInput` is the single scenario-loading entry point: it
 * gates on `contractVersion` BEFORE schema validation, rejecting
 * missing/unknown/older/newer versions with a structured error that
 * names the expected vs found version. It never crashes and never
 * silently coerces.
 *
 * `inputHash` is computed over the canonicalized (validated) input with
 * a dependency-free stable stringify + FNV-1a hash, so identical logical
 * inputs hash identically regardless of key order.
 */

import { z } from "zod";
import { SimError } from "./errors";

export const SIM_INPUT_CONTRACT_VERSION = "1.0.0";
export const SIM_OUTPUT_CONTRACT_VERSION = "1.0.0";

/* ------------------------------------------------------------------ */
/* Numeric primitives: finite, always.                                 */
/* ------------------------------------------------------------------ */

/**
 * zod's number() already rejects NaN/Infinity in v4, but the contract
 * must reject them *by requirement*, not by library accident — so the
 * finite check is explicit and its failure message says so.
 */
function finiteNumber() {
  return z.number().refine((v) => Number.isFinite(v), {
    message: "must be a finite number (NaN and Infinity are rejected)",
  });
}

function positiveFinite() {
  return finiteNumber().refine((v) => v > 0, {
    message: "must be a positive finite number",
  });
}

function nonNegativeFinite() {
  return finiteNumber().refine((v) => v >= 0, {
    message: "must be a non-negative finite number",
  });
}

function finiteInt() {
  return finiteNumber().refine((v) => Number.isInteger(v), {
    message: "must be an integer",
  });
}

/* ------------------------------------------------------------------ */
/* SimulationInput                                                     */
/* ------------------------------------------------------------------ */

const ArrivalProcessSchema = z
  .object({
    /** Arrival profile shape. */
    type: z.enum(["poisson", "scheduled", "bunched"]),
    /** Base arrival rate. Unit: trucks/hour (explicit in the name). */
    ratePerHour: nonNegativeFinite(),
    /** Multiplier applied inside the peak window. Unit: dimensionless ×. */
    peakFactor: positiveFinite().optional(),
    /** Peak window bounds. Unit: hours on the 24h clock. */
    peakWindowStartHour: finiteNumber().min(0).max(24).optional(),
    peakWindowEndHour: finiteNumber().min(0).max(24).optional(),
    /** Share of trucks holding an appointment (scheduled only). Unit: percent. */
    appointmentSharePct: finiteNumber().min(0).max(100).optional(),
    /** Explicit unit field for the rate. */
    unit: z.literal("trucks/hour").optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (
      a.peakWindowStartHour !== undefined &&
      a.peakWindowEndHour !== undefined &&
      a.peakWindowEndHour <= a.peakWindowStartHour
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "peakWindowEndHour must be greater than peakWindowStartHour",
        path: ["peakWindowEndHour"],
      });
    }
  });

const ResourceSchema = z
  .object({
    id: z.string().min(1).max(100),
    kind: z.enum(["gate-lane", "yard-crane", "berth", "customs-desk"]),
    /** Server count. Unit: given by the `unit` field. */
    count: finiteInt().positive().max(1000),
    /** Explicit unit, e.g. "lanes", "cranes", "berths". */
    unit: z.string().min(1).max(40),
  })
  .strict();

const DistributionSchema = z
  .object({
    family: z.enum(["exponential", "lognormal", "deterministic", "uniform"]),
    /** Mean of the distribution. Unit: minutes (explicit in the name). */
    meanMin: positiveFinite(),
    /** Lognormal shape parameter (lognormal only). Dimensionless. */
    sigma: nonNegativeFinite().optional(),
    /** Uniform lower bound in minutes (uniform only). */
    minMin: finiteNumber().optional(),
    /** Uniform upper bound in minutes (uniform only). */
    maxMin: finiteNumber().optional(),
    unit: z.literal("minutes").optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    const issue = (message: string, path: string[]) =>
      ctx.addIssue({ code: "custom", message, path });
    // Reject negative/NaN parameters is handled by the field schemas;
    // here we enforce family-internal consistency.
    if (d.family === "lognormal" && d.sigma === undefined) {
      issue("lognormal distribution requires a sigma parameter", ["sigma"]);
    }
    if (d.family !== "lognormal" && d.sigma !== undefined) {
      issue(`sigma is only meaningful for the lognormal family`, ["sigma"]);
    }
    if (d.family === "deterministic" && d.sigma !== undefined && d.sigma !== 0) {
      issue("deterministic distribution must not carry a non-zero sigma", [
        "sigma",
      ]);
    }
    if (d.family === "uniform") {
      if (d.minMin === undefined || d.maxMin === undefined) {
        issue("uniform distribution requires minMin and maxMin", ["minMin"]);
      } else if (!(d.maxMin > d.minMin)) {
        issue("uniform maxMin must be greater than minMin", ["maxMin"]);
      }
    }
    if (d.family !== "uniform" && (d.minMin !== undefined || d.maxMin !== undefined)) {
      issue("minMin/maxMin are only meaningful for the uniform family", [
        "minMin",
      ]);
    }
  });

const ServiceTimeDistributionsSchema = z
  .object({
    gateServiceMin: DistributionSchema,
    yardHandlingMin: DistributionSchema,
    berthLoadingMin: DistributionSchema,
  })
  .strict();

const CostAssumptionSchema = z
  .object({
    name: z.string().min(1).max(120),
    /** Monetary amount; unit given by `perUnit`, currency by `currency`. */
    amount: nonNegativeFinite(),
    /** ISO 4217 code, e.g. "USD", "MAD". */
    currency: z.string().min(1).max(10),
    /** Explicit unit, e.g. "truck-hour", "TEU", "day". */
    perUnit: z.string().min(1).max(60),
    kind: z.enum(["measured", "illustrative"]),
    source: z.string().max(300).optional(),
  })
  .strict();

export const SimulationInputSchema = z
  .object({
    contractVersion: z.literal(SIM_INPUT_CONTRACT_VERSION),
    scenarioId: z.string().min(1).max(200),
    /** Base seed for the deterministic baseSeed+replication scheme. */
    seed: finiteInt(),
    /** Monte Carlo replications. Upper bound 10000 keeps runs sane. */
    replications: finiteInt().min(2).max(10000),
    /** Simulated horizon. Unit: hours (explicit in the name). */
    horizonHours: positiveFinite(),
    resources: z.array(ResourceSchema).min(1).max(100),
    arrivalProcess: ArrivalProcessSchema,
    serviceTimeDistributions: ServiceTimeDistributionsSchema,
    costAssumptions: z.array(CostAssumptionSchema).max(100),
    /** Share of grain trucks. Unit: percent. */
    grainSharePct: finiteNumber().min(0).max(100).optional(),
    grainPriority: z.boolean().optional(),
  })
  .strict();

export type SimulationInput = z.infer<typeof SimulationInputSchema>;

/* ------------------------------------------------------------------ */
/* SimulationOutput                                                    */
/* ------------------------------------------------------------------ */

const KpiSchema = z
  .object({
    /** Unit: trucks/hour. */
    throughputTrucksPerHour: finiteNumber(),
    /** Unit: TEU/hour. */
    throughputTeuPerHour: finiteNumber(),
    /** Unit: minutes. */
    meanWaitMin: finiteNumber(),
    /** Unit: minutes. */
    p95WaitMin: finiteNumber(),
    /** Mean of per-replication maximum gate queue. Unit: trucks. */
    maxQueueMean: finiteNumber(),
    /** Unit: percent (0–100). */
    utilizationPct: z
      .object({
        gate: finiteNumber(),
        yard: finiteNumber(),
        berth: finiteNumber(),
      })
      .strict(),
    /** Unit: tonnes. */
    co2Tonnes: finiteNumber(),
    completedTrucksMean: finiteNumber(),
    totalTrucksMean: finiteNumber(),
  })
  .strict();

const ConfidenceIntervalSchema = z
  .object({
    metric: z.string().min(1),
    unit: z.string().min(1),
    /** CI method, per the Phase B statistical audit. */
    method: z.literal("student-t"),
    confidenceLevel: z.literal(0.95),
    replications: finiteInt().positive(),
    mean: finiteNumber(),
    low: finiteNumber(),
    high: finiteNumber(),
  })
  .strict();

const AssumptionSchema = z
  .object({
    statement: z.string().min(1).max(1000),
    kind: z.enum(["measured", "illustrative"]),
  })
  .strict();

export const SimulationOutputSchema = z
  .object({
    contractVersion: z.literal(SIM_OUTPUT_CONTRACT_VERSION),
    scenarioId: z.string().min(1).max(200),
    /** FNV-1a hash of the canonicalized input. 16 lowercase hex chars. */
    inputHash: z.string().regex(/^[0-9a-f]{16}$/),
    /** ISO 8601 UTC timestamp of run completion. */
    completedAtUtc: z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
      message: "must be a parseable ISO 8601 timestamp",
    }),
    kpis: KpiSchema,
    confidenceIntervals: z.array(ConfidenceIntervalSchema).max(100),
    assumptions: z.array(AssumptionSchema).max(200),
    warnings: z.array(z.string().max(1000)).max(100),
  })
  .strict();

export type SimulationOutput = z.infer<typeof SimulationOutputSchema>;

/* ------------------------------------------------------------------ */
/* Canonicalization + hashing (no new dependencies).                   */
/* ------------------------------------------------------------------ */

/**
 * Deterministic JSON serialization: object keys sorted recursively,
 * -0 normalized to 0. Identical logical inputs always produce the
 * identical string regardless of key order. Throws SimError (never a
 * raw TypeError) on non-finite numbers.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SimError(
        "VALIDATION_ERROR",
        "Cannot canonicalize a non-finite number for hashing."
      );
    }
    return JSON.stringify(value === 0 ? 0 : value);
  }
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`
  );
  return `{${parts.join(",")}}`;
}

/** FNV-1a 64-bit hash over UTF-8 bytes → 16 lowercase hex chars. */
function fnv1a64Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  // BigInt() constructor calls (not literals): the tsconfig target is
  // below ES2020, which forbids BigInt literal syntax.
  let h = BigInt("0xcbf29ce484222325");
  const prime = BigInt("0x100000001b3");
  const mask = BigInt("0xffffffffffffffff");
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

/**
 * Hash of the canonicalized (validated) input. Use this as the
 * idempotency key component and the audit-trail run identifier.
 */
export function inputHash(input: SimulationInput): string {
  return fnv1a64Hex(stableStringify(input));
}

/* ------------------------------------------------------------------ */
/* Scenario loader: version gate + contract validation.                */
/* ------------------------------------------------------------------ */

/** Compare "x.y.z" semver strings. null when either side is unparsable. */
function compareSemver(a: string, b: string): number | null {
  const parse = (s: string): number[] | null => {
    const parts = s.split(".");
    if (parts.length !== 3) return null;
    const nums = parts.map(Number);
    if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
    return nums;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export interface FieldIssue {
  path: string;
  message: string;
}

/**
 * Load and validate a scenario payload against the SimulationInput
 * contract. The version gate runs FIRST: missing, unparsable, older, or
 * newer `contractVersion` values are rejected with a VERSION_MISMATCH
 * error naming the expected vs found version — never coerced, never a
 * crash. Schema failures become VALIDATION_ERROR with field-level
 * issues.
 */
export function loadSimulationInput(raw: unknown): SimulationInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SimError(
      "VALIDATION_ERROR",
      "Simulation input must be a JSON object."
    );
  }
  const record = raw as Record<string, unknown>;
  const found = record.contractVersion;

  if (typeof found !== "string" || found.length === 0) {
    throw new SimError(
      "VERSION_MISMATCH",
      `Missing contractVersion: this loader expects SimulationInput contract version "${SIM_INPUT_CONTRACT_VERSION}".`,
      { expected: SIM_INPUT_CONTRACT_VERSION, found: found ?? null }
    );
  }
  const cmp = compareSemver(found, SIM_INPUT_CONTRACT_VERSION);
  if (cmp === null) {
    throw new SimError(
      "VERSION_MISMATCH",
      `Unparsable contractVersion "${found}": expected "${SIM_INPUT_CONTRACT_VERSION}".`,
      { expected: SIM_INPUT_CONTRACT_VERSION, found }
    );
  }
  if (cmp !== 0) {
    const relation = cmp > 0 ? "newer than" : "older than";
    throw new SimError(
      "VERSION_MISMATCH",
      `Unsupported contractVersion "${found}": it is ${relation} the supported version "${SIM_INPUT_CONTRACT_VERSION}". Migrate the scenario; it will not be coerced.`,
      { expected: SIM_INPUT_CONTRACT_VERSION, found }
    );
  }

  const parsed = SimulationInputSchema.safeParse(record);
  if (!parsed.success) {
    const issues: FieldIssue[] = parsed.error.issues.map((i) => ({
      path: i.path.length > 0 ? i.path.join(".") : "(root)",
      message: i.message,
    }));
    throw new SimError(
      "VALIDATION_ERROR",
      `Simulation input failed contract validation (${issues.length} issue${issues.length === 1 ? "" : "s"}).`,
      { expected: SIM_INPUT_CONTRACT_VERSION, issues }
    );
  }
  return parsed.data;
}

/** Validate a constructed SimulationOutput before it is cached/served. */
export function assertValidOutput(output: unknown): asserts output is SimulationOutput {
  const parsed = SimulationOutputSchema.safeParse(output);
  if (!parsed.success) {
    const issues: FieldIssue[] = parsed.error.issues.map((i) => ({
      path: i.path.length > 0 ? i.path.join(".") : "(root)",
      message: i.message,
    }));
    throw new SimError(
      "INTERNAL_ERROR",
      "Constructed simulation output failed its own contract — this is a bug, not a user error.",
      { issues }
    );
  }
}
