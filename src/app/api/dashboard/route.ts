// GET /api/dashboard — real metrics straight from the database.
// NO hardcoded numbers: every figure is a live COUNT(*) / GROUP BY query.

import { NextRequest, NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { handleRouteError, ok } from "@/lib/route-helpers";
import { AppointmentStatus, VerificationOutcome } from "@/contracts";

export async function GET(req: NextRequest): Promise<Response> {
  try {
    await requireApiRole(req, "operations_viewer");
    const db = getDb();

    const appointmentsByStatus: Record<string, number> = {};
    for (const s of AppointmentStatus.options) appointmentsByStatus[s] = 0;
    for (const row of db
      .prepare("SELECT status, COUNT(*) AS n FROM appointments GROUP BY status")
      .all() as { status: string; n: number }[]) {
      appointmentsByStatus[row.status] = row.n;
    }

    const verificationsByOutcome: Record<string, number> = {};
    for (const o of VerificationOutcome.options) verificationsByOutcome[o] = 0;
    for (const row of db
      .prepare(
        "SELECT outcome, COUNT(*) AS n FROM gate_verification_events GROUP BY outcome"
      )
      .all() as { outcome: string; n: number }[]) {
      verificationsByOutcome[row.outcome] = row.n;
    }

    const pendingReviews = (
      db
        .prepare("SELECT COUNT(*) AS n FROM review_items WHERE status = 'pending'")
        .get() as { n: number }
    ).n;

    const totalAppointments = Object.values(appointmentsByStatus).reduce(
      (a, b) => a + b,
      0
    );
    const totalVerifications = Object.values(verificationsByOutcome).reduce(
      (a, b) => a + b,
      0
    );

    const recentAudit = (
      db
        .prepare(
          `SELECT id, actor_id, action, entity, entity_id, detail_json, created_at
           FROM audit_events
           ORDER BY created_at DESC
           LIMIT 10`
        )
        .all() as {
        id: string;
        actor_id: string;
        action: string;
        entity: string;
        entity_id: string;
        detail_json: string;
        created_at: string;
      }[]
    ).map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      action: r.action,
      entity: r.entity,
      entityId: r.entity_id,
      detail: r.detail_json,
      createdAt: r.created_at,
    }));

    return ok({
      appointmentsByStatus,
      verificationsByOutcome,
      pendingReviews,
      totalAppointments,
      totalVerifications,
      recentAudit,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
