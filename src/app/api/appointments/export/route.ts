// GET /api/appointments/export?status= — CSV of appointments for reporting
// (any signed-in role). Same columns as the import format, plus platform
// fields, so exports can feed spreadsheets and BI tools directly.

import { NextRequest, NextResponse } from "next/server";
import { AppointmentStatus } from "@/contracts";
import { requireApiRole, jsonError } from "@/lib/auth";
import { toCsv } from "@/lib/csv";
import { getDb } from "@/lib/db/client";
import { handleRouteError } from "@/lib/route-helpers";

export async function GET(req: NextRequest): Promise<Response> {
  try {
    await requireApiRole(req, "operations_viewer");
    const statusParam = req.nextUrl.searchParams.get("status");
    const status = statusParam ? AppointmentStatus.safeParse(statusParam) : null;
    if (status && !status.success) return jsonError(400, "validation_error", "Unknown status.");
    const rows = getDb()
      .prepare(
        `SELECT id, truck_plate, container_no, driver_name, scheduled_at, status, created_by, created_at, updated_at, idempotency_key
         FROM appointments ${status ? "WHERE status = ?" : ""} ORDER BY scheduled_at`
      )
      .all(...(status ? [status.data] : [])) as Array<Record<string, string | null>>;
    const csv = toCsv(
      ["id", "truck_plate", "container_no", "driver_name", "scheduled_at", "status", "external_ref", "created_by", "created_at", "updated_at"],
      rows.map((r) => [
        r.id,
        r.truck_plate,
        r.container_no,
        r.driver_name,
        r.scheduled_at,
        r.status,
        r.idempotency_key?.startsWith("import:") ? r.idempotency_key.slice(7) : null,
        r.created_by,
        r.created_at,
        r.updated_at,
      ])
    );
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="appointments-${new Date().toISOString().slice(0, 10)}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
