// Shared dashboard queries — direct DB reads (no hardcoded numbers).
// Used by the dashboard page (server component) and /api/dashboard.

import { getDb } from "./db/client";
import {
  AppointmentStatus,
  VerificationOutcome,
  type AuditAction,
} from "@/contracts";

const SIX_STATUSES: AppointmentStatus[] = [
  "requested",
  "confirmed",
  "checked-in",
  "completed",
  "cancelled",
  "no-show",
];

const OUTCOMES: VerificationOutcome[] = ["auto-accept", "human-review", "scan-failed"];

export interface DashboardStats {
  synthetic: true;
  appointmentsByStatus: Record<AppointmentStatus, number>;
  totalAppointments: number;
  verificationsByOutcome: Record<VerificationOutcome, number>;
  totalVerifications: number;
  pendingReviews: number;
  plansBySolver: Record<string, number>;
  totalPlans: number;
  provenOptimalPlans: number;
  simulationsByScenario: Record<string, number>;
  totalSimulations: number;
  recentAudit: Array<{
    id: string;
    actorId: string;
    action: string;
    entity: string;
    entityId: string;
    detailJson: string;
    createdAt: string;
  }>;
}

function zeroRecord<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<T, number>;
}

export function getDashboardStats(): DashboardStats {
  const db = getDb();

  const appointmentsByStatus = zeroRecord(SIX_STATUSES);
  const rows = db
    .prepare("SELECT status, COUNT(*) AS c FROM appointments GROUP BY status")
    .all() as Array<{ status: string; c: number }>;
  for (const r of rows) {
    // Only count contract statuses; anything else is a data anomaly and is
    // surfaced separately, never silently merged into a legal status.
    const parsed = AppointmentStatus.safeParse(r.status);
    if (parsed.success) appointmentsByStatus[parsed.data] = r.c;
  }

  const verificationsByOutcome = zeroRecord(OUTCOMES);
  const vrows = db
    .prepare(
      "SELECT outcome, COUNT(*) AS c FROM gate_verification_events GROUP BY outcome"
    )
    .all() as Array<{ outcome: string; c: number }>;
  for (const r of vrows) {
    const parsed = VerificationOutcome.safeParse(r.outcome);
    if (parsed.success) verificationsByOutcome[parsed.data] = r.c;
  }

  const pendingRow = db
    .prepare("SELECT COUNT(*) AS c FROM review_items WHERE status = 'pending'")
    .get() as { c: number };

  const recentAudit = db
    .prepare(
      `SELECT id, actor_id AS actorId, action, entity, entity_id AS entityId,
              detail_json AS detailJson, created_at AS createdAt
       FROM audit_events
       ORDER BY created_at DESC, rowid DESC
       LIMIT 10`
    )
    .all() as DashboardStats["recentAudit"];

  const totalAppointments = Object.values(appointmentsByStatus).reduce((a, b) => a + b, 0);
  const totalVerifications = Object.values(verificationsByOutcome).reduce((a, b) => a + b, 0);

  // Planning runs — real counts from berth_plans. proven_optimal is 1 only
  // when the exact solver proved optimality; never inferred.
  const plansBySolver: Record<string, number> = {};
  for (const r of db
    .prepare("SELECT solver, COUNT(*) AS c FROM berth_plans GROUP BY solver")
    .all() as Array<{ solver: string; c: number }>) {
    plansBySolver[r.solver] = r.c;
  }
  const totalPlans = Object.values(plansBySolver).reduce((a, b) => a + b, 0);
  const provenOptimalPlans = (
    db.prepare("SELECT COUNT(*) AS c FROM berth_plans WHERE proven_optimal = 1").get() as { c: number }
  ).c;

  // Simulation runs — real counts from simulation_runs. All synthetic, uncalibrated.
  const simulationsByScenario: Record<string, number> = {};
  for (const r of db
    .prepare("SELECT scenario_name, COUNT(*) AS c FROM simulation_runs GROUP BY scenario_name")
    .all() as Array<{ scenario_name: string; c: number }>) {
    simulationsByScenario[r.scenario_name] = r.c;
  }
  const totalSimulations = Object.values(simulationsByScenario).reduce((a, b) => a + b, 0);

  return {
    synthetic: true,
    appointmentsByStatus,
    totalAppointments,
    verificationsByOutcome,
    totalVerifications,
    pendingReviews: pendingRow.c,
    plansBySolver,
    totalPlans,
    provenOptimalPlans,
    simulationsByScenario,
    totalSimulations,
    recentAudit,
  };
}

/** Display-friendly labels for audit actions. */
export function auditActionLabel(action: string): string {
  const labels: Record<AuditAction, string> = {
    "appointment.created": "Appointment created",
    "appointment.status_changed": "Status changed",
    "scan.submitted": "Scan submitted",
    "scan.verified": "Scan verified",
    "review.decided": "Review decided",
    "plan.created": "Berth plan created",
    "planning.run_created": "Planning run created",
    "simulation.created": "Simulation created",
    "simulation.run_created": "Simulation run created",
    "auth.login": "Signed in",
    "auth.logout": "Signed out",
    "auth.login_failed": "Failed sign-in",
    "auth.account_locked": "Account locked",
    "auth.password_changed": "Password changed",
    "auth.mfa_enabled": "MFA enabled",
    "auth.mfa_disabled": "MFA disabled",
    "auth.session_revoked": "Sessions revoked",
    "user.created": "User created",
    "user.updated": "User updated",
    "settings.changed": "Settings changed",
    "import.completed": "Data imported",
    "audit.exported": "Audit exported",
  };
  return (labels as Record<string, string>)[action] ?? action;
}
