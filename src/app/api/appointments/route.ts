// POST /api/appointments — create an appointment (atomic idempotency).
// GET  /api/appointments — list appointments, newest first, optional ?status= filter.

import { NextRequest, NextResponse } from "next/server";
import { requireApiRole, jsonError } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { audit } from "@/lib/audit";
import {
  readJsonLimited,
  handleRouteError,
  ok,
} from "@/lib/route-helpers";
import {
  createAppointment,
  listAppointments,
} from "@/lib/appointments";
import {
  CreateAppointmentInput,
  AppointmentStatus,
} from "@/contracts";

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const session = await requireApiRole(req, "operations_operator");
    const body = await readJsonLimited(req);

    const parsed = CreateAppointmentInput.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            code: "validation_error",
            message: "Invalid appointment data.",
            details: parsed.error.issues,
          },
        },
        { status: 400 }
      );
    }

    const input = parsed.data;
    const db = getDb();
    const { record, created } = createAppointment(db, session.userId, {
      truckPlate: input.truckPlate,
      containerNo: input.containerNo ?? null,
      driverName: input.driverName ?? null,
      scheduledAt: input.scheduledAt,
      idempotencyKey: input.idempotencyKey,
    });

    if (created) {
      audit(session.userId, "appointment.created", "appointment", record.id, {
        idempotentReplay: false,
      });
      return ok(record, 201);
    }
    // Idempotent replay: the key was seen before — return the EXISTING record.
    audit(session.userId, "appointment.created", "appointment", record.id, {
      idempotentReplay: true,
    });
    return ok(record, 200);
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  try {
    await requireApiRole(req, "operations_viewer");

    const statusParam = req.nextUrl.searchParams.get("status");
    if (statusParam !== null) {
      const parsed = AppointmentStatus.safeParse(statusParam);
      if (!parsed.success) {
        return jsonError(
          400,
          "invalid_status_filter",
          `Invalid status filter. Must be one of: ${AppointmentStatus.options.join(", ")}.`
        );
      }
      return ok(listAppointments(getDb(), parsed.data));
    }
    return ok(listAppointments(getDb()));
  } catch (err) {
    return handleRouteError(err);
  }
}
