/**
 * Phase D — versioned schemas for REAL-WORLD VALIDATION DATA.
 *
 * This module defines the shape that measured operational data must take
 * before it can be used to calibrate or validate the twin:
 * observed throughput, waiting-time distributions, hourly queue lengths,
 * service rates, and resource utilization.
 *
 * PLAIN STATEMENT OF FACT: no real operational data exists yet. Every
 * dataset the project ships today has `dataKind: "synthetic"` — generated
 * by the engine itself from known parameters to exercise the validation
 * machinery (parsing, schema enforcement, calibration/hold-out workflow).
 * Synthetic data proves SOFTWARE CORRECTNESS ONLY. It says nothing about
 * real-world accuracy. A `dataKind: "measured"` dataset requires measured
 * operational data from the terminal operator and/or ANP (see
 * docs/ACCEPTANCE.md for the data ask), and until one exists the twin is
 * NOT a validated digital twin.
 *
 * Doctrine (mirrors Phase C contracts): `schemaVersion` is version-gated
 * BEFORE schema validation (`validateValidationDataset` never coerces,
 * never crashes); all durations/rates carry explicit units in field names;
 * numeric fields reject NaN/Infinity explicitly; objects are `.strict()`.
 */

import { z } from "zod";
import { SimError } from "./errors";

/** Version of the validation-data schema. Gate before parsing. */
export const SCHEMA_VERSION = "1.0.0";

/* ------------------------------------------------------------------ */
/* Numeric primitives (finite, always — mirrors contracts.ts).          */
/* ------------------------------------------------------------------ */

function finiteNumber() {
  return z.number().refine((v) => Number.isFinite(v), {
    message: "must be a finite number (NaN and Infinity are rejected)",
  });
}

function nonNegativeFinite() {
  return finiteNumber().refine((v) => v >= 0, {
    message: "must be a non-negative finite number",
  });
}

function positiveFinite() {
  return finiteNumber().refine((v) => v > 0, {
    message: "must be a positive finite number",
  });
}

function positiveInt() {
  return finiteNumber().refine((v) => Number.isInteger(v) && v > 0, {
    message: "must be a positive integer",
  });
}

/** ISO calendar date, e.g. "2026-10-05". */
const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO calendar date (YYYY-MM-DD)");

/** Parseable ISO 8601 timestamp (UTC expected). */
const IsoTimestampSchema = z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
  message: "must be a parseable ISO 8601 timestamp",
});

const ResourceKindSchema = z.enum(["gate-lane", "yard-crane", "berth"]);

/* ------------------------------------------------------------------ */
/* Observation series                                                  */
/* ------------------------------------------------------------------ */

/** Measured throughput for one calendar day. */
const ThroughputDaySchema = z
  .object({
    /** Calendar date of the observation. */
    date: IsoDateSchema,
    /** Containers processed that day. Unit: TEU/day. */
    teuPerDay: nonNegativeFinite(),
    /** Trucks processed that day. Unit: trucks/day. */
    trucksPerDay: nonNegativeFinite(),
    /** Where this row came from, e.g. "TOS export", "gate tally". */
    source: z.string().max(200).optional(),
    notes: z.string().max(500).optional(),
  })
  .strict();

/** Observed queue length at the start of one clock hour. */
const QueueHourSchema = z
  .object({
    /** Hour start, UTC. Unit: ISO 8601 timestamp. */
    timestampUtc: IsoTimestampSchema,
    /** Trucks waiting at the gate. Unit: trucks. */
    gateQueueTrucks: nonNegativeFinite(),
    /** Trucks waiting in the yard. Unit: trucks. */
    yardQueueTrucks: nonNegativeFinite().optional(),
    /** Trucks waiting at the berth. Unit: trucks. */
    berthQueueTrucks: nonNegativeFinite().optional(),
    source: z.string().max(200).optional(),
  })
  .strict();

/** Summary of the gate-wait distribution for one calendar day. */
const WaitDistributionDaySchema = z
  .object({
    date: IsoDateSchema,
    /** Trucks in the sample. Unit: trucks (count). */
    nTrucks: positiveInt(),
    /** Mean gate wait. Unit: minutes. */
    meanMin: nonNegativeFinite(),
    /** Median gate wait. Unit: minutes. */
    p50Min: nonNegativeFinite().optional(),
    /** 95th percentile gate wait. Unit: minutes. */
    p95Min: nonNegativeFinite().optional(),
    /** 99th percentile gate wait. Unit: minutes. */
    p99Min: nonNegativeFinite().optional(),
    /** Longest observed wait. Unit: minutes. */
    maxMin: nonNegativeFinite().optional(),
    /** Where this row came from, e.g. "TOS export", "gate tally". */
    source: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((w, ctx) => {
    const ordered: Array<[number | undefined, string]> = [
      [w.p50Min, "p50Min"],
      [w.p95Min, "p95Min"],
      [w.p99Min, "p99Min"],
      [w.maxMin, "maxMin"],
    ];
    let prev = -Infinity;
    let prevName = "0";
    for (const [v, name] of ordered) {
      if (v === undefined) continue;
      if (v < prev) {
        ctx.addIssue({
          code: "custom",
          message: `${name} (${v}) must be >= ${prevName} (${prev}): distribution quantiles must be non-decreasing`,
          path: [name],
        });
      }
      prev = v;
      prevName = name;
    }
    if (w.maxMin !== undefined && w.meanMin > w.maxMin) {
      ctx.addIssue({
        code: "custom",
        message: `meanMin (${w.meanMin}) cannot exceed maxMin (${w.maxMin})`,
        path: ["meanMin"],
      });
    }
  });

/** Directly measured service performance for one resource over a period. */
const ServiceRateSchema = z
  .object({
    resourceKind: ResourceKindSchema,
    /** Identifier of the specific lane/crane/berth, if known. */
    resourceId: z.string().max(100).optional(),
    /** Start of the measurement window, UTC. */
    periodStartUtc: IsoTimestampSchema,
    /** End of the measurement window, UTC. */
    periodEndUtc: IsoTimestampSchema,
    /** Trucks served in the window. Unit: trucks. */
    trucksServed: nonNegativeFinite(),
    /** Time the resource spent busy in the window. Unit: minutes. */
    busyMinutes: nonNegativeFinite(),
    /** Mean service time, when measured directly. Unit: minutes. */
    meanServiceMin: positiveFinite().optional(),
    source: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (Date.parse(s.periodEndUtc) <= Date.parse(s.periodStartUtc)) {
      ctx.addIssue({
        code: "custom",
        message: "periodEndUtc must be after periodStartUtc",
        path: ["periodEndUtc"],
      });
    }
  });

/** Measured utilization of one resource for one calendar day. */
const UtilizationSchema = z
  .object({
    resourceKind: ResourceKindSchema,
    resourceId: z.string().max(100).optional(),
    date: IsoDateSchema,
    /** Share of available time spent busy. Unit: percent (0–100). */
    utilizationPct: finiteNumber().min(0).max(100),
    source: z.string().max(200).optional(),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* Provenance                                                          */
/* ------------------------------------------------------------------ */

const ProvenanceSchema = z
  .object({
    /** Who/where the data came from, e.g. "Terminal operator TOS export". */
    source: z.string().min(1).max(300),
    /** Person or team that collected it, if known. */
    collectedBy: z.string().max(200).optional(),
    /** Contact for questions about the data. */
    contact: z.string().max(200).optional(),
    /** How it was collected (sensors, manual tallies, system exports). */
    collectionMethod: z.string().max(500).optional(),
    /** What the data does NOT cover — gaps, exclusions, known biases. */
    coverageNote: z.string().max(1000).optional(),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* Top-level validation dataset                                        */
/* ------------------------------------------------------------------ */

export const ValidationDatasetSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    datasetId: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    provenance: ProvenanceSchema,
    /**
     * "measured" = real operational data from the port.
     * "synthetic" = generated by the engine itself for machinery testing.
     * Synthetic datasets prove software correctness only — never
     * real-world accuracy.
     */
    dataKind: z.enum(["measured", "synthetic"]),
    period: z
      .object({
        startDate: IsoDateSchema,
        endDate: IsoDateSchema,
      })
      .strict()
      .superRefine((p, ctx) => {
        if (p.endDate < p.startDate) {
          ctx.addIssue({
            code: "custom",
            message: "period.endDate must not be before period.startDate",
            path: ["endDate"],
          });
        }
      }),
    /** Daily throughput observations. */
    throughputDaily: z.array(ThroughputDaySchema).max(3660).default([]),
    /** Hourly queue-length observations. */
    queueHourly: z.array(QueueHourSchema).max(100000).default([]),
    /** Daily wait-time distribution summaries. */
    waitTimeDistribution: z.array(WaitDistributionDaySchema).max(3660).default([]),
    /** Directly measured service rates. */
    serviceRates: z.array(ServiceRateSchema).max(100000).default([]),
    /** Measured resource utilization. */
    utilization: z.array(UtilizationSchema).max(100000).default([]),
    notes: z.string().max(5000).optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    const seriesCount =
      d.throughputDaily.length +
      d.queueHourly.length +
      d.waitTimeDistribution.length +
      d.serviceRates.length +
      d.utilization.length;
    if (seriesCount === 0) {
      ctx.addIssue({
        code: "custom",
        message:
          "a validation dataset must contain at least one observation series (throughput, queues, waits, service rates, or utilization)",
        path: [],
      });
    }
  });

export type ValidationDataset = z.infer<typeof ValidationDatasetSchema>;

/* ------------------------------------------------------------------ */
/* Version-gated validator                                             */
/* ------------------------------------------------------------------ */

export interface ValidationFieldIssue {
  path: string;
  message: string;
}

/**
 * Validate a raw payload as a validation dataset. The schema-version
 * gate runs FIRST: a missing, unparsable, older, or newer
 * `schemaVersion` is rejected with a VERSION_MISMATCH error naming the
 * expected vs found version — never coerced, never a crash. Schema
 * failures become VALIDATION_ERROR with field-level issues.
 */
export function validateValidationDataset(raw: unknown): ValidationDataset {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SimError(
      "VALIDATION_ERROR",
      "Validation dataset must be a JSON object."
    );
  }
  const record = raw as Record<string, unknown>;
  const found = record.schemaVersion;
  if (typeof found !== "string" || found.length === 0) {
    throw new SimError(
      "VERSION_MISMATCH",
      `Missing schemaVersion: this validator expects validation-data schema version "${SCHEMA_VERSION}".`,
      { expected: SCHEMA_VERSION, found: found ?? null }
    );
  }
  if (found !== SCHEMA_VERSION) {
    throw new SimError(
      "VERSION_MISMATCH",
      `Unsupported schemaVersion "${found}": expected "${SCHEMA_VERSION}". Migrate the dataset; it will not be coerced.`,
      { expected: SCHEMA_VERSION, found }
    );
  }
  const parsed = ValidationDatasetSchema.safeParse(record);
  if (!parsed.success) {
    const issues: ValidationFieldIssue[] = parsed.error.issues.map((i) => ({
      path: i.path.length > 0 ? i.path.join(".") : "(root)",
      message: i.message,
    }));
    throw new SimError(
      "VALIDATION_ERROR",
      `Validation dataset failed schema validation (${issues.length} issue${issues.length === 1 ? "" : "s"}).`,
      { expected: SCHEMA_VERSION, issues }
    );
  }
  return parsed.data;
}
