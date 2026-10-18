/**
 * lib/datasets/schemas.ts
 *
 * Versioned zod schemas for the REAL-WORLD data TAS-Casablanca would need
 * for empirical validation (Phase D).
 *
 * READ THIS FIRST — NO REAL DATA EXISTS. This repository contains zero
 * operational records from the Port of Casablanca, Marsa Maroc, ANP, or
 * any terminal operator. These schemas define the SHAPE of the data that
 * the terminal operator / ANP would need to provide before any claim
 * about real-world accuracy (queue reduction, wait-time prediction error,
 * no-show calibration) can be tested. Every fixture under
 * fixtures/synthetic/ is hand-written SYNTHETIC data that proves software
 * correctness only — it validates nothing about the real port.
 *
 * Schema version: "1.0.0" (DATASET_SCHEMA_VERSION). Bump on any breaking
 * change; validators reject unknown versions so stale extracts fail loudly.
 *
 * Conventions shared by all four schemas:
 *  - All timestamps are ISO 8601 UTC strings ending in "Z".
 *  - Every numeric field documents its UNIT in the field description.
 *  - Schemas are .strict(): unknown fields are rejected (typos in an
 *    operator extract must fail, not silently pass).
 *  - parse*() validators never throw — they return { ok, value?, issues }.
 */

import { z } from "zod";

/** Current version of every dataset schema in this file. */
export const DATASET_SCHEMA_VERSION = "1.0.0" as const;

/** Structured, machine-readable validation issue (never a raw throw). */
export interface DatasetIssue {
  path: string;
  code: string;
  message: string;
}

export interface DatasetParseResult<T> {
  ok: boolean;
  value?: T;
  issues: DatasetIssue[];
}

const UTC_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** ISO 8601 UTC datetime string, e.g. "2026-10-20T08:30:00Z". */
const UtcDatetime = z
  .string()
  .refine((s) => UTC_DATETIME_RE.test(s) && !Number.isNaN(Date.parse(s)), {
    message: "must be an ISO 8601 UTC datetime ending in 'Z'",
  });

const TerminalId = z.enum(["T1", "T2", "T3"]);
const GateId = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const CargoType = z.enum(["general", "grain", "reefer", "hazmat"]);
const MoveType = z.enum(["import", "export"]);

function toIssues(error: z.ZodError): DatasetIssue[] {
  return error.issues.map((i) => ({
    path: i.path.map(String).join(".") || "(root)",
    code: String(i.code),
    message: i.message,
  }));
}

function makeValidator<T>(schema: z.ZodType<T>) {
  return (v: unknown): DatasetParseResult<T> => {
    if (
      typeof v === "object" &&
      v !== null &&
      (v as Record<string, unknown>).schema_version !== undefined &&
      (v as Record<string, unknown>).schema_version !== DATASET_SCHEMA_VERSION
    ) {
      return {
        ok: false,
        issues: [
          {
            path: "schema_version",
            code: "custom",
            message: `unsupported schema_version (expected "${DATASET_SCHEMA_VERSION}")`,
          },
        ],
      };
    }
    const r = schema.safeParse(v);
    if (r.success) return { ok: true, value: r.data, issues: [] };
    return { ok: false, issues: toIssues(r.error) };
  };
}

/* ------------------------------------------------------------------ */
/* 1. Truck arrivals                                                   */
/* ------------------------------------------------------------------ */

/**
 * One observed truck arrival at a gate.
 *
 * SOURCE: terminal operating system (TOS) gate logs or ANPR/camera feed
 * at the gate. REQUIRED for: calibrating the arrival-time distribution
 * the simulator currently invents (lib/data.ts pickPreferredWindow) and
 * for measuring real queue build-up.
 *
 * WHAT THE OPERATOR MUST PROVIDE: timestamped gate passages with the
 * appointment reference when one exists. Plate numbers are PII — the
 * schema takes a SHA-256 hex hash instead (optional; omit if the
 * operator cannot share even hashes).
 */
export const TruckArrivalRecord = z
  .object({
    schema_version: z.literal(DATASET_SCHEMA_VERSION),
    /** Stable record id, e.g. "arr_2026-10-20_0001". REQUIRED. */
    arrival_id: z.string().min(1).max(64),
    /** When the truck crossed the gate line. Unit: ISO 8601 UTC. REQUIRED. */
    occurred_at_utc: UtcDatetime,
    /** Terminal where the arrival was observed. REQUIRED. */
    terminal: TerminalId,
    /** Physical gate (0=express, 1=standard, 2=inspection). REQUIRED. */
    gate_id: GateId,
    /** SHA-256 hex of the plate (privacy-preserving). OPTIONAL. */
    truck_plate_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, { message: "must be a 64-char lowercase hex SHA-256" })
      .optional(),
    /** Cargo family, when known. OPTIONAL. */
    cargo: CargoType.optional(),
    /** Import or export move, when known. OPTIONAL. */
    move: MoveType.optional(),
    /** TAS appointment id, when the truck arrived on an appointment. OPTIONAL. */
    appointment_id: z.string().min(1).max(64).optional(),
    /** Trucks ahead of it in the queue at arrival, when measured. Unit: count. OPTIONAL. */
    queue_position_at_arrival: z.number().int().min(0).optional(),
    /** How the record was captured. REQUIRED. */
    recorded_by: z.enum(["tos", "anpr", "manual", "camera"]),
  })
  .strict();
export type TruckArrivalRecord = z.infer<typeof TruckArrivalRecord>;

/** Validate one unknown value as a TruckArrivalRecord. Never throws. */
export const parseTruckArrivalRecord = makeValidator(TruckArrivalRecord);

/* ------------------------------------------------------------------ */
/* 2. Appointment adherence                                            */
/* ------------------------------------------------------------------ */

/**
 * Whether a booked appointment was kept, and how late the truck was.
 *
 * SOURCE: TAS booking records joined with gate check-in logs. REQUIRED
 * for: calibrating the no-show model (lib/predictor.ts noShowProbability
 * is currently an uncalibrated heuristic) and for measuring the
 * reschedule/adherence KPIs the optimizer optimizes.
 *
 * WHAT THE OPERATOR MUST PROVIDE: for each appointment, the scheduled
 * slot and the actual check-in time (or the no-show / cancellation flag).
 */
export const AppointmentAdherenceRecord = z
  .object({
    schema_version: z.literal(DATASET_SCHEMA_VERSION),
    /** TAS appointment id (links to the booking). REQUIRED. */
    appointment_id: z.string().min(1).max(64),
    /** Scheduled slot start. Unit: ISO 8601 UTC. REQUIRED. */
    scheduled_start_utc: UtcDatetime,
    /** Actual gate check-in time. Unit: ISO 8601 UTC. Null when the truck never checked in. REQUIRED (nullable). */
    actual_checkin_utc: UtcDatetime.nullable(),
    /** Outcome of the appointment. REQUIRED. */
    outcome: z.enum(["arrived-on-time", "arrived-late", "arrived-early", "no-show", "cancelled"]),
    /**
     * actual_checkin − scheduled_start. Unit: minutes (negative = early).
     * REQUIRED when outcome is arrived-*, must be null otherwise.
     */
    lateness_min: z.number().nullable(),
    /** How far ahead the appointment was booked. Unit: hours. REQUIRED. */
    lead_time_hours: z.number().min(0),
    /** Carrier name or anonymized id, when shareable. OPTIONAL. */
    carrier: z.string().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const arrived = r.outcome.startsWith("arrived");
    if (arrived && r.lateness_min === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lateness_min"],
        message: "lateness_min is required when the truck arrived",
      });
    }
    if (!arrived && r.lateness_min !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lateness_min"],
        message: "lateness_min must be null when the truck did not arrive",
      });
    }
    if (arrived && r.actual_checkin_utc === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actual_checkin_utc"],
        message: "actual_checkin_utc is required when the truck arrived",
      });
    }
  });
export type AppointmentAdherenceRecord = z.infer<typeof AppointmentAdherenceRecord>;

/** Validate one unknown value as an AppointmentAdherenceRecord. Never throws. */
export const parseAppointmentAdherenceRecord = makeValidator(
  AppointmentAdherenceRecord,
);

/* ------------------------------------------------------------------ */
/* 3. Gate service times                                                */
/* ------------------------------------------------------------------ */

/**
 * How long one truck occupied a gate (check-in to release).
 *
 * SOURCE: gate system timestamps or induction-loop dwell measurements.
 * REQUIRED for: replacing the hard-coded per-gate service times
 * (lib/types.ts GATE_PROFILES: 4/5/8 min — currently engineering guesses,
 * NOT measurements) with fitted distributions, which drive slot capacity
 * and every wait estimate in the system.
 *
 * WHAT THE OPERATOR MUST PROVIDE: per-truck service durations by gate,
 * ideally by cargo/lane so the model can condition on them.
 */
export const GateServiceTimeRecord = z
  .object({
    schema_version: z.literal(DATASET_SCHEMA_VERSION),
    /** Stable record id. REQUIRED. */
    record_id: z.string().min(1).max(64),
    /** Gate where service happened (0=express, 1=standard, 2=inspection). REQUIRED. */
    gate_id: GateId,
    /** When service started. Unit: ISO 8601 UTC. REQUIRED. */
    started_at_utc: UtcDatetime,
    /** Check-in to gate release. Unit: SECONDS (not minutes). REQUIRED, > 0. */
    service_duration_sec: z.number().positive(),
    /** Cargo family, when known. OPTIONAL. */
    cargo: CargoType.optional(),
    /** Lane the truck used. REQUIRED. */
    lane: z.enum(["express", "standard", "inspection"]),
    /** Whether a physical inspection was performed. OPTIONAL. */
    inspection_performed: z.boolean().optional(),
  })
  .strict();
export type GateServiceTimeRecord = z.infer<typeof GateServiceTimeRecord>;

/** Validate one unknown value as a GateServiceTimeRecord. Never throws. */
export const parseGateServiceTimeRecord = makeValidator(GateServiceTimeRecord);

/* ------------------------------------------------------------------ */
/* 4. Queue measurements                                                */
/* ------------------------------------------------------------------ */

/**
 * Observed queue length / wait at a gate at a point in time.
 *
 * SOURCE: induction loops, camera-based counting, or manual counts by
 * gate staff. REQUIRED for: validating the simulator's queue predictions
 * (lib/simulation.ts) against reality — the "−62% max queue" style claim
 * from the literature only transfers if the baseline queues match.
 *
 * WHAT THE OPERATOR MUST PROVIDE: timestamped queue snapshots through
 * the day, especially across the morning peak.
 */
export const QueueMeasurement = z
  .object({
    schema_version: z.literal(DATASET_SCHEMA_VERSION),
    /** Stable record id. REQUIRED. */
    measurement_id: z.string().min(1).max(64),
    /** When the measurement was taken. Unit: ISO 8601 UTC. REQUIRED. */
    measured_at_utc: UtcDatetime,
    /** Gate observed (0=express, 1=standard, 2=inspection). REQUIRED. */
    gate_id: GateId,
    /** Trucks waiting (excluding the one in service). Unit: count. REQUIRED. */
    queue_length_trucks: z.number().int().min(0),
    /** Mean wait of trucks currently queued, when measurable. Unit: minutes. OPTIONAL. */
    avg_wait_min: z.number().min(0).optional(),
    /** How the measurement was taken. REQUIRED. */
    source: z.enum(["induction-loop", "camera-ai", "manual-count", "tos"]),
  })
  .strict();
export type QueueMeasurement = z.infer<typeof QueueMeasurement>;

/** Validate one unknown value as a QueueMeasurement. Never throws. */
export const parseQueueMeasurement = makeValidator(QueueMeasurement);

/* ------------------------------------------------------------------ */
/* Envelope                                                            */
/* ------------------------------------------------------------------ */

/**
 * File envelope for extracts handed over by the operator: one JSON file
 * per dataset, shaped as
 *   { "synthetic": false, "schema_version": "1.0.0", "records": [...] }
 * The `synthetic` flag MUST be true for the in-repo fixtures and false
 * for real operator extracts — validators below do not check it, but
 * every consumer MUST refuse synthetic data for calibration.
 */
export const DatasetEnvelope = z
  .object({
    /** True ONLY for the hand-written fixtures under fixtures/synthetic/. */
    synthetic: z.boolean(),
    schema_version: z.literal(DATASET_SCHEMA_VERSION),
    records: z.array(z.unknown()),
  })
  .strict();
export type DatasetEnvelope = z.infer<typeof DatasetEnvelope>;

/** Validate an envelope's shape (not its records). Never throws. */
export const parseDatasetEnvelope = makeValidator(DatasetEnvelope);
