// GET /api/gate/reviews — pending human-review items with their event details.

import { NextRequest, NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { handleRouteError, ok } from "@/lib/route-helpers";

interface ReviewRow {
  id: string;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
  created_at: string;
  event_id: string;
  appointment_id: string;
  plate_read: string | null;
  container_read: string | null;
  confidence: number | null;
  outcome: string;
  reason: string;
  verified_by: string;
  event_created_at: string;
  truck_plate: string;
  container_no: string | null;
}

export async function GET(req: NextRequest): Promise<Response> {
  try {
    await requireApiRole(req, "operations_viewer");

    const rows = getDb()
      .prepare(
        `SELECT r.id, r.status, r.decided_by, r.decided_at, r.note, r.created_at,
                e.id AS event_id, e.appointment_id, e.plate_read, e.container_read,
                e.confidence, e.outcome, e.reason, e.verified_by,
                e.created_at AS event_created_at,
                a.truck_plate, a.container_no
         FROM review_items r
         JOIN gate_verification_events e ON e.id = r.event_id
         JOIN appointments a ON a.id = e.appointment_id
         WHERE r.status = 'pending'
         ORDER BY r.created_at ASC`
      )
      .all() as unknown as ReviewRow[];

    return ok(
      rows.map((r) => ({
        id: r.id,
        status: r.status,
        decidedBy: r.decided_by,
        decidedAt: r.decided_at,
        note: r.note,
        createdAt: r.created_at,
        event: {
          id: r.event_id,
          appointmentId: r.appointment_id,
          simulated: true,
          plateRead: r.plate_read,
          containerRead: r.container_read,
          confidence: r.confidence,
          outcome: r.outcome,
          reason: r.reason,
          verifiedBy: r.verified_by,
          createdAt: r.event_created_at,
        },
        appointment: {
          id: r.appointment_id,
          truckPlate: r.truck_plate,
          containerNo: r.container_no,
        },
      }))
    );
  } catch (err) {
    return handleRouteError(err);
  }
}
