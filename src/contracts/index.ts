// Unified platform contracts — Zod v1.0.0 shapes.
// Reuses the contract patterns from all four repos: UTC-internal datetimes,
// explicit units, stable IDs, strict objects.

import { z } from "zod";
import { PRESETS as PORT_TWIN_PRESETS } from "@/vendored/porttwin/sim/scenarios";

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

export const Role = z.enum([
  "operations_viewer",
  "operations_operator",
  "planner",
  "supervisor",
  "administrator",
]);
export type Role = z.infer<typeof Role>;
/** @deprecated legacy name from the demo slice — use Role. */
export const DemoRole = Role;
export type DemoRole = Role;

// ── Users & authentication ───────────────────────────────────────────────

export const Email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "must be a valid email address");

export const LoginInput = z
  .object({ email: Email, password: z.string().min(1).max(256) })
  .strict();

export const MfaVerifyInput = z
  .object({ challenge: z.string().min(1).max(4096), code: z.string().min(6).max(10) })
  .strict();

export const CreateUserInput = z
  .object({
    email: Email,
    label: z.string().trim().min(1).max(100),
    role: Role,
    password: z.string().min(1).max(256),
  })
  .strict();

export const UpdateUserInput = z
  .object({
    label: z.string().trim().min(1).max(100).optional(),
    role: Role.optional(),
    disabled: z.boolean().optional(),
    unlock: z.literal(true).optional(),
    resetPassword: z.string().min(1).max(256).optional(),
    resetMfa: z.literal(true).optional(),
  })
  .strict();

export const ChangePasswordInput = z
  .object({ currentPassword: z.string().max(256), newPassword: z.string().min(1).max(256) })
  .strict();

// ── Audit ────────────────────────────────────────────────────────────────

export const AuditAction = z.enum([
  "appointment.created",
  "appointment.status_changed",
  "scan.submitted",
  "scan.verified",
  "review.decided",
  "plan.created",
  "planning.run_created", // BerthWise: a berth plan run was created (or idempotently replayed)
  "simulation.created",
  "simulation.run_created",
  "auth.login",
  "auth.logout",
  "auth.login_failed",
  "auth.account_locked",
  "auth.password_changed",
  "auth.mfa_enabled",
  "auth.mfa_disabled",
  "auth.session_revoked",
  "user.created",
  "user.updated",
  "settings.changed",
  "import.completed",
  "audit.exported",
]);
export type AuditAction = z.infer<typeof AuditAction>;

// ── PortTwin: simulation ─────────────────────────────────────────────────

// Scenario ids are derived from the vendored PortTwin preset definitions
// (src/vendored/porttwin/sim/scenarios.ts) — the contract can never drift
// from the engine's scenario list.
const SIMULATION_SCENARIO_IDS = PORT_TWIN_PRESETS.map((p) => p.id);
export const SimulationScenarioId = z.enum(
  SIMULATION_SCENARIO_IDS as [string, ...string[]]
);
export type SimulationScenarioId = z.infer<typeof SimulationScenarioId>;

/**
 * Small allowlist of numeric parameter overrides applied on top of the
 * scenario preset before the run. Everything else comes from the preset.
 * horizonHours maps onto the engine's simHours.
 */
export const SimulationParamOverrides = z
  .object({
    horizonHours: z.number().finite().positive().max(168).optional(),
    trucksPerDay: z.number().finite().positive().max(10000).optional(),
    numGates: z.number().int().min(1).max(8).optional(),
    gateServiceMeanMin: z.number().finite().positive().max(60).optional(),
  })
  .strict();
export type SimulationParamOverrides = z.infer<typeof SimulationParamOverrides>;

/**
 * Request to run a PortTwin scenario. scenarioName is the operator's label;
 * scenarioId must be a vendored preset id. The vendored
 * SimulationInputSchema does the heavy validation inside runScenario.
 */
export const CreateSimulationInput = z
  .object({
    scenarioName: z.string().min(1).max(80),
    scenarioId: SimulationScenarioId,
    seed: z.number().int().default(42),
    replications: z.number().int().min(10).max(500).default(100),
    idempotencyKey: z.string().min(8).max(64).optional(),
    paramOverrides: SimulationParamOverrides.optional(),
  })
  .strict();
export type CreateSimulationInput = z.infer<typeof CreateSimulationInput>;

// ── BerthWise: planning ──────────────────────────────────────────────────
// Berth allocation planning contracts. All demo inputs through these schemas
// are SYNTHETIC — generated for illustration, never real port data.
// The vendored solvers (src/vendored/berthwise) are never imported here.

/**
 * Synthetic vessel to schedule. Mirrors the required fields of the vendored
 * `Vessel` type; operational fields the solvers need (id, line, etaHours,
 * handlingHours, teu, origin) are derived server-side at plan time.
 */
export const VesselInput = z
  .object({
    name: z.string().min(1).max(60).describe("Synthetic vessel name"),
    lengthM: z.number().positive().describe("Length overall in metres (> 0)"),
    draftM: z.number().positive().describe("Loaded draft in metres (> 0)"),
    eta: DateTimeZ.describe("Estimated time of arrival, UTC (synthetic)"),
    etd: DateTimeZ.describe(
      "Estimated time of departure, UTC (synthetic); must be after eta"
    ),
    grainCapable: z
      .boolean()
      .describe("Grain cargo: true requires a grain-capable berth"),
  })
  .strict()
  .superRefine((v, ctx) => {
    const etaMs = Date.parse(v.eta);
    const etdMs = Date.parse(v.etd);
    if (Number.isNaN(etaMs) || Number.isNaN(etdMs)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "eta and etd must be valid calendar datetimes",
        path: ["eta"],
      });
      return;
    }
    if (etdMs <= etaMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "etd must be after eta",
        path: ["etd"],
      });
    }
  });
export type VesselInput = z.infer<typeof VesselInput>;

/**
 * Synthetic berth. Mirrors the vendored `Berth` type; `maxDraftM` is the
 * contract-level draft limit (the vendored solver checks length and grain
 * capability — draft is enforced by the planning layer).
 */
export const BerthInput = z
  .object({
    name: z.string().min(1).max(60).describe("Synthetic berth name"),
    lengthM: z.number().positive().describe("Berth length in metres (> 0)"),
    maxDraftM: z
      .number()
      .positive()
      .describe("Maximum vessel draft the berth accepts, in metres (> 0)"),
    grainCapable: z.boolean().describe("Can serve grain vessels"),
  })
  .strict();
export type BerthInput = z.infer<typeof BerthInput>;

/**
 * Solver choice for a plan run. `exact` is the branch-and-bound solver —
 * it only runs on instances with ≤ 8 vessels and falls back to the greedy
 * heuristic (clearly labelled) on larger instances. ALNS is deliberately
 * NOT offered: it is superlinear and unsuitable for interactive use.
 */
export const SolverChoice = z.enum([
  "exact",
  "greedy",
  "annealing",
  "tabu",
  "genetic",
]);
export type SolverChoice = z.infer<typeof SolverChoice>;

export const CreatePlanInput = z
  .object({
    scenarioName: z
      .string()
      .min(1)
      .max(80)
      .describe("Scenario name (synthetic demo label)"),
    vessels: z
      .array(VesselInput)
      .min(1, "at least one vessel is required")
      .max(20, "at most 20 vessels per plan run"),
    berths: z
      .array(BerthInput)
      .min(1, "at least one berth is required")
      .max(10, "at most 10 berths per plan run"),
    solver: SolverChoice,
    seed: z.number().int().default(42).describe("Deterministic seed for the solvers"),
    idempotencyKey: z.string().min(8).max(64).optional(),
  })
  .strict();
export type CreatePlanInput = z.infer<typeof CreatePlanInput>;
