// GET /api/appointments/[id] — appointment detail + its verification history.

import { NextRequest } from "next/server";
import { requireApiRole, jsonError } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { handleRouteError, ok } from "@/lib/route-helpers";
import { getAppointment } from "@/lib/appointments";

interface VerificationEventRow {
  id: string;
  appointment_id: string;
  simulated: number;
  plate_read: string | null;
  container_read: string | null;
  confidence: number | null;
  outcome: string;
  reason: string;
  verified_by: string;
  created_at: string;
  review_status: string | null;
  review_decided_by: string | null;
  review_decided_at: string | null;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    await requireApiRole(req, "operations_viewer");
    const { id } = await ctx.params;

    const db = getDb();
    const appointment = getAppointment(db, id);
    if (!appointment) {
      return jsonError(404, "not_found", "Appointment not found.");
    }

    const rows = db
      .prepare(
        `SELECT e.id, e.appointment_id, e.simulated, e.plate_read, e.container_read,
                e.confidence, e.outcome, e.reason, e.verified_by, e.created_at,
                r.status AS review_status, r.decided_by AS review_decided_by,
                r.decided_at AS review_decided_at
         FROM gate_verification_events e
         LEFT JOIN review_items r ON r.event_id = e.id
         WHERE e.appointment_id = ?
         ORDER BY e.created_at DESC`
      )
      .all(id) as unknown as VerificationEventRow[];

    const verificationHistory = rows.map((r) => ({
      id: r.id,
      appointmentId: r.appointment_id,
      simulated: r.simulated === 1,
      plateRead: r.plate_read,
      containerRead: r.container_read,
      confidence: r.confidence,
      outcome: r.outcome,
      reason: r.reason,
      verifiedBy: r.verified_by,
      createdAt: r.created_at,
      reviewStatus: r.review_status,
      reviewDecidedBy: r.review_decided_by,
      reviewDecidedAt: r.review_decided_at,
    }));

    return ok({ appointment, verificationHistory });
  } catch (err) {
    return handleRouteError(err);
  }
}
