// Unified platform contracts — Zod v1.0.0 shapes.
// Reuses the contract patterns from all four repos: UTC-internal datetimes,
// explicit units, stable IDs, strict objects.

import { z } from "zod";

// ── Shared primitives ────────────────────────────────────────────────────

/** ISO 8601 UTC datetime string, strict-Z (e.g. 2026-10-18T13:00:00Z) */
export const DateTimeZ = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/,
  "must be ISO 8601 UTC with Z suffix"
);

/** Stable server-generated ID (UUID v4) */
export const EntityId = z.string().uuid();

// ── TAS: appointments ────────────────────────────────────────────────────
// Status enum REUSED from the TAS v1.0.0 contract (vendored) — do NOT invent.
// See src/vendored/tas/contracts/appointment.ts for the source of truth.
export const AppointmentStatus = z.enum([
  "requested",
  "confirmed",
  "checked-in",
  "completed",
  "cancelled",
  "no-show",
]);
export type AppointmentStatus = z.infer<typeof AppointmentStatus>;

// Legal transitions from the TAS contract state machine.
export const STATUS_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  requested: ["confirmed", "cancelled"],
  confirmed: ["checked-in", "cancelled"],
  "checked-in": ["completed", "cancelled", "no-show"],
  completed: [],
  cancelled: [],
  "no-show": [],
};

export const CreateAppointmentInput = z.object({
  truckPlate: z.string().min(1).max(20),
  containerNo: z.string().max(11).nullable().optional(), // ISO 6346 format validated separately
  driverName: z.string().max(100).nullable().optional(),
  scheduledAt: DateTimeZ,
  idempotencyKey: z.string().min(8).max(64).optional(),
}).strict();

export const AppointmentRecord = z.object({
  id: EntityId,
  truckPlate: z.string(),
  containerNo: z.string().nullable(),
  driverName: z.string().nullable(),
  scheduledAt: z.string(), // ISO UTC from DB
  status: AppointmentStatus,
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ── GateWatch: verification ──────────────────────────────────────────────

export const VerificationOutcome = z.enum([
  "auto-accept",
  "human-review",
  "scan-failed",
]);
export type VerificationOutcome = z.infer<typeof VerificationOutcome>;

/**
 * Simulated scan submission. The scan data is ALWAYS synthetic in the demo.
 * The appointment is loaded server-side by ID — client-supplied appointment
 * data is NEVER trusted (this is the replay-attack boundary).
 */
export const SubmitScanInput = z.object({
  appointmentId: EntityId, // server loads the appointment; client data ignored
  plateRead: z.string().max(20).nullable().optional(),
  containerRead: z.string().max(11).nullable().optional(),
  // Confidence: 0-100. NaN, out-of-range, or missing → NEVER auto-accept.
  // Validated by routeScan logic, not just schema.
  confidence: z.number().nullable().optional(),
}).strict();

export const VerificationRecord = z.object({
  id: EntityId,
  appointmentId: EntityId,
  simulated: z.literal(true),
  plateRead: z.string().nullable(),
  containerRead: z.string().nullable(),
  confidence: z.number().nullable(),
  outcome: VerificationOutcome,
  reason: z.string(),
  verifiedBy: z.string(),
  createdAt: z.string(),
});

// ── Auth ─────────────────────────────────────────────────────────────────

export const DemoRole = z.enum([
  "operations_viewer",
  "operations_operator",
  "planner",
  "supervisor",
  "administrator",
]);
export type DemoRole = z.infer<typeof DemoRole>;

// ── Audit ────────────────────────────────────────────────────────────────

export const AuditAction = z.enum([
  "appointment.created",
  "appointment.status_changed",
  "scan.submitted",
  "scan.verified",
  "review.decided",
  "plan.created",
  "simulation.created",
  "auth.login",
  "auth.logout",
]);
export type AuditAction = z.infer<typeof AuditAction>;
