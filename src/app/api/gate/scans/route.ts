// POST /api/gate/scans — submit a (SIMULATED) gate scan.
// THE TRUSTED BOUNDARY: the appointment is loaded server-side by ID.
// Client-supplied appointment data is NEVER trusted (replay-attack fix).
// Scans are ALWAYS synthetic in the demo (simulated=true on every record).

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireApiRole, jsonError } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { audit } from "@/lib/audit";
import { readJsonLimited, handleRouteError, ok, withTransaction } from "@/lib/route-helpers";
import { getAppointment, setAppointmentStatus } from "@/lib/appointments";
import {
  SubmitScanInput,
  STATUS_TRANSITIONS,
  type VerificationOutcome,
} from "@/contracts";
import {
  routeScan,
  needsReview,
  DEFAULT_REVIEW_THRESHOLD,
} from "@/vendored/gatewatch/review";

const normalize = (s: string | null): string | null => {
  const t = (s ?? "").trim().toUpperCase();
  return t === "" ? null : t;
};

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const session = await requireApiRole(req, "operations_operator");
    const body = await readJsonLimited(req);

    const parsed = SubmitScanInput.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            code: "validation_error",
            message: "Invalid scan submission.",
            details: parsed.error.issues,
          },
        },
        { status: 400 }
      );
    }
    const input = parsed.data;

    // NEVER trust appointment data from the client — load from DB by ID.
    const db = getDb();
    const appointment = getAppointment(db, input.appointmentId);
    if (!appointment) {
      return jsonError(404, "not_found", "Appointment not found.");
    }

    // Confidence: missing/null → NaN → needsReview fails closed to human-review.
    const confidence: number = input.confidence ?? NaN;

    const plateRead = normalize(input.plateRead ?? null);
    const containerRead = normalize(input.containerRead ?? null);
    const hasAnyRead = plateRead !== null || containerRead !== null;

    // Base verdict from the vendored choke point (confidence routing only).
    const base = routeScan(
      { error: null, confidence },
      DEFAULT_REVIEW_THRESHOLD
    );

    // Data-vs-appointment matching (fail-closed: any mismatch → human review).
    const plateMatch = plateRead === normalize(appointment.truckPlate);
    const containerMatch = appointment.containerNo
      ? containerRead === normalize(appointment.containerNo)
      : containerRead === null; // appointment has no container → a read is new info, review it
    const matches = plateMatch && containerMatch;

    // Auto-accept implies a status transition — the TAS state machine gates it.
    // Re-validated again inside setAppointmentStatus; this pre-check keeps the
    // failure mode as human-review instead of a 500.
    const eligibleForCheckIn = (
      STATUS_TRANSITIONS[appointment.status] ?? []
    ).includes("checked-in");

    let outcome: VerificationOutcome;
    let reason: string;

    if (!hasAnyRead) {
      outcome = "scan-failed";
      reason = "No plate or container data captured (both reads empty).";
    } else if (base === "human-review") {
      outcome = "human-review";
      reason = needsReview(confidence, DEFAULT_REVIEW_THRESHOLD)
        ? `Confidence ${Number.isFinite(confidence) ? confidence : "missing/invalid"} below the review threshold (${DEFAULT_REVIEW_THRESHOLD}).`
        : "Scan routed to human review.";
    } else if (!matches) {
      outcome = "human-review";
      reason = "Scan data does not match the appointment record.";
    } else if (!eligibleForCheckIn) {
      outcome = "human-review";
      reason = `Appointment is '${appointment.status}' and cannot transition to checked-in.`;
    } else {
      outcome = "auto-accept";
      reason =
        "Confidence at/above threshold and scan matches the appointment record.";
    }

    const eventId = randomUUID();
    const now = new Date().toISOString();
    const confidenceDb = Number.isFinite(confidence) ? confidence : null;

    // Persist atomically: verification event + optional review item + optional check-in.
    const { reviewItemId } = withTransaction(db, (): { reviewItemId: string | null } => {
      db.prepare(
        `INSERT INTO gate_verification_events
         (id, appointment_id, simulated, plate_read, container_read, confidence, outcome, reason, verified_by, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        eventId,
        appointment.id,
        plateRead,
        containerRead,
        confidenceDb,
        outcome,
        reason,
        session.userId,
        now
      );

      let reviewItemId: string | null = null;
      if (outcome === "human-review") {
        reviewItemId = randomUUID();
        db.prepare(
          `INSERT INTO review_items (id, event_id, status, created_at)
           VALUES (?, ?, 'pending', ?)`
        ).run(reviewItemId, eventId, now);
      }

      if (outcome === "auto-accept") {
        // Re-validated against STATUS_TRANSITIONS inside; throws if illegal.
        setAppointmentStatus(db, appointment.id, "checked-in");
      }

      return { reviewItemId };
    });

    audit(session.userId, "scan.verified", "gate_verification_event", eventId, {
      outcome,
      autoAccepted: outcome === "auto-accept",
      confidence: confidenceDb,
      appointmentStatus: appointment.status,
    });

    return ok(
      {
        verification: {
          id: eventId,
          appointmentId: appointment.id,
          simulated: true,
          plateRead,
          containerRead,
          confidence: confidenceDb,
          outcome,
          reason,
          verifiedBy: session.userId,
          createdAt: now,
        },
        outcome,
        reason,
        reviewItemId,
      },
      201
    );
  } catch (err) {
    return handleRouteError(err);
  }
}
