// PATCH /api/appointments/[id]/status — transition status via the TAS state machine.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireApiRole, jsonError } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { audit } from "@/lib/audit";
import { readJsonLimited, handleRouteError, ok } from "@/lib/route-helpers";
import { getAppointment, setAppointmentStatus, IllegalTransitionError } from "@/lib/appointments";
import { AppointmentStatus } from "@/contracts";

const StatusChangeInput = z
  .object({ to: AppointmentStatus })
  .strict();

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole(req, "operations_operator");
    const { id } = await ctx.params;
    const body = await readJsonLimited(req);

    const parsed = StatusChangeInput.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            code: "validation_error",
            message: "Invalid status change.",
            details: parsed.error.issues,
          },
        },
        { status: 400 }
      );
    }

    const db = getDb();
    const current = getAppointment(db, id);
    if (!current) {
      return jsonError(404, "not_found", "Appointment not found.");
    }

    try {
      const updated = setAppointmentStatus(db, id, parsed.data.to);
      audit(session.userId, "appointment.status_changed", "appointment", id, {
        from: current.status,
        to: parsed.data.to,
      });
      return ok(updated);
    } catch (err) {
      if (err instanceof IllegalTransitionError) {
        return jsonError(
          400,
          "illegal_transition",
          `Cannot move appointment from '${err.from}' to '${err.to}'.`
        );
      }
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}
