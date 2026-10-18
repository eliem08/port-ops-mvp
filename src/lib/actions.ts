"use server";

// Server actions used by the UI shell. Every mutation:
//  1. reads the session server-side (getSession), fail closed on none;
//  2. checks the minimum role for the action;
//  3. validates input with the platform Zod contracts;
//  4. appends an audit event.
// They deliberately bypass the REST routes the API worker owns — no conflicts.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { getSession, type DemoSession } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  CreateAppointmentInput,
  CreateSimulationInput,
  STATUS_TRANSITIONS,
  AppointmentStatus,
  type AppointmentStatus as AppointmentStatusT,
  type DemoRole,
} from "@/contracts";
import { z } from "zod";
import {
  createSimulationRun,
  SimulationValidationError,
} from "@/lib/simulation";

const ROLE_RANK: Record<DemoRole, number> = {
  operations_viewer: 0,
  operations_operator: 1,
  planner: 1,
  supervisor: 2,
  administrator: 3,
};

async function requireRole(minRole: DemoRole): Promise<DemoSession> {
  const session = await getSession();
  if (!session) throw new Error("unauthenticated: demo login required");
  if (ROLE_RANK[session.role] < ROLE_RANK[minRole]) {
    throw new Error(
      `forbidden: role '${session.role}' cannot perform this action (requires '${minRole}')`
    );
  }
  return session;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
}

// ── Appointments ─────────────────────────────────────────────────────────

export async function createAppointmentAction(
  prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const session = await requireRole("operations_operator");
  const db = getDb();

  const raw = {
    truckPlate: String(formData.get("truckPlate") ?? "").trim(),
    containerNo: String(formData.get("containerNo") ?? "").trim() || null,
    driverName: String(formData.get("driverName") ?? "").trim() || null,
    scheduledAt: toStrictZ(String(formData.get("scheduledAt") ?? "")),
    idempotencyKey: randomUUID(), // auto-generated per the demo spec
  };

  const parsed = CreateAppointmentInput.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "scheduledAt");
      fieldErrors[key] = issue.message;
    }
    return { ok: false, message: "Validation failed — fix the highlighted fields.", fieldErrors };
  }

  const id = randomUUID();
  try {
    db.prepare(
      `INSERT INTO appointments
       (id, truck_plate, container_no, driver_name, scheduled_at, status, created_by, idempotency_key)
       VALUES (?, ?, ?, ?, ?, 'requested', ?, ?)`
    ).run(
      id,
      parsed.data.truckPlate,
      parsed.data.containerNo ?? null,
      parsed.data.driverName ?? null,
      parsed.data.scheduledAt,
      session.userId,
      parsed.data.idempotencyKey ?? randomUUID()
    );
  } catch (e) {
    return { ok: false, message: "Could not create appointment (possible duplicate submission)." };
  }

  audit(session.userId, "appointment.created", "appointment", id, { synthetic: true });
  revalidatePath("/appointments");
  revalidatePath("/");
  redirect(`/appointments/${id}`);
}

function toStrictZ(datetimeLocal: string): string {
  // datetime-local gives "2026-10-19T14:30" — convert to strict UTC Z form.
  if (!datetimeLocal) return datetimeLocal;
  const d = new Date(datetimeLocal);
  if (Number.isNaN(d.getTime())) return datetimeLocal;
  return d.toISOString();
}

export async function transitionAppointmentAction(
  appointmentId: string,
  toStatus: string
): Promise<ActionResult> {
  const session = await requireRole("operations_operator");
  const db = getDb();

  const target = AppointmentStatus.safeParse(toStatus);
  if (!target.success) {
    return { ok: false, message: `Invalid status '${toStatus}'.` };
  }
  const row = db
    .prepare("SELECT id, status FROM appointments WHERE id = ?")
    .get(appointmentId) as { id: string; status: string } | undefined;
  if (!row) return { ok: false, message: "Appointment not found." };

  const current = AppointmentStatus.safeParse(row.status);
  if (!current.success) {
    return { ok: false, message: `Current status '${row.status}' is not a legal contract status.` };
  }
  const legal = STATUS_TRANSITIONS[current.data];
  if (!legal.includes(target.data)) {
    return {
      ok: false,
      message: `Illegal transition: ${current.data} → ${target.data}. Legal: ${legal.join(", ") || "none"}.`,
    };
  }

  db.prepare(
    "UPDATE appointments SET status = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(target.data, appointmentId);
  audit(session.userId, "appointment.status_changed", "appointment", appointmentId, {
    from: current.data,
    to: target.data,
  });
  revalidatePath(`/appointments/${appointmentId}`);
  revalidatePath("/appointments");
  revalidatePath("/");
  return { ok: true, message: `Status changed to ${target.data}.` };
}

// ── GateWatch simulated scans ────────────────────────────────────────────

const ScanFormSchema = z.object({
  appointmentId: z.string().uuid(),
  plateRead: z.string().max(20).trim().nullish(),
  containerRead: z.string().max(11).trim().nullish(),
  confidence: z.number().nullish(),
});

function humanReason(codes: string[]): string {
  const map: Record<string, string> = {
    "verified-match": "Plate and container match the appointment; confidence above threshold.",
    "plate-mismatch": "Plate read does not match the appointment plate.",
    "container-mismatch": "Container read does not match the appointment container.",
    "low-plate-confidence": "Plate OCR confidence below the auto-accept threshold (70).",
    "low-container-confidence": "Container OCR confidence below the auto-accept threshold (70).",
    "outside-slot-window": "Scan arrived outside the appointment slot window.",
    "gate-mismatch": "Scan gate does not match the appointment gate.",
    "appointment-cancelled": "Appointment is cancelled — crossing denied.",
    "appointment-not-active": "Appointment is in a terminal state — crossing denied.",
    "appointment-unconfirmed": "Appointment is requested but not yet confirmed — needs a human.",
    "no-appointment-ref": "No appointment reference could be resolved.",
  };
  const parts = codes.map((c) => map[c] ?? c);
  return parts.length ? parts.join(" ") : "No reason codes returned.";
}

export interface ScanResult {
  ok: boolean;
  message: string;
  outcome?: "auto-accept" | "human-review" | "scan-failed";
  reason?: string;
  eventId?: string;
}

export async function submitScanAction(formData: FormData): Promise<ScanResult> {
  const session = await requireRole("operations_operator");

  const confRaw = String(formData.get("confidence") ?? "").trim();
  const parsed = ScanFormSchema.safeParse({
    appointmentId: String(formData.get("appointmentId") ?? ""),
    plateRead: String(formData.get("plateRead") ?? "").trim() || null,
    containerRead: String(formData.get("containerRead") ?? "").trim() || null,
    confidence: confRaw === "" ? null : Number(confRaw),
  });
  if (!parsed.success) {
    return { ok: false, message: "Invalid scan input." };
  }
  const { appointmentId, plateRead, containerRead, confidence } = parsed.data;

  const db = getDb();
  const appt = db
    .prepare(
      "SELECT id, truck_plate, container_no, scheduled_at, status FROM appointments WHERE id = ?"
    )
    .get(appointmentId) as
    | {
        id: string;
        truck_plate: string;
        container_no: string | null;
        scheduled_at: string;
        status: string;
      }
    | undefined;
  if (!appt) return { ok: false, message: "Appointment not found." };

  // Use the vendored GateWatch verification logic (pure function).
  const { verifyGateEventAgainstAppointment } = await import(
    "@/vendored/gatewatch/verify"
  );
  const scannedAt = new Date();
  const slotStart = new Date(new Date(appt.scheduled_at).getTime() - 60 * 60_000);
  const slotEnd = new Date(new Date(appt.scheduled_at).getTime() + 60 * 60_000);
  const conf = confidence ?? Number.NaN; // missing/NaN confidence NEVER auto-accepts

  const decision = verifyGateEventAgainstAppointment(
    {
      plate: plateRead ?? "",
      containerNumber: containerRead ?? "",
      scannedAtUtc: scannedAt.toISOString(),
      gate: "DEMO-GATE",
      containerConfidence: conf,
      plateConfidence: conf,
    },
    {
      appointmentId: appt.id,
      status: appt.status as AppointmentStatusT,
      containerNumber: appt.container_no ?? "",
      plate: appt.truck_plate,
      slotStartUtc: slotStart.toISOString(),
      slotEndUtc: slotEnd.toISOString(),
      gate: "DEMO-GATE",
    }
  );

  const outcome =
    decision.decision === "authorized"
      ? "auto-accept"
      : decision.decision === "manual-review"
        ? "human-review"
        : "scan-failed";
  const reason = humanReason(decision.reasonCodes);

  const eventId = randomUUID();
  db.prepare(
    `INSERT INTO gate_verification_events
     (id, appointment_id, simulated, plate_read, container_read, confidence, outcome, reason, verified_by)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`
  ).run(
    eventId,
    appointmentId,
    plateRead ?? null,
    containerRead ?? null,
    Number.isFinite(conf) ? conf : null,
    outcome,
    reason,
    session.userId
  );
  audit(session.userId, "scan.submitted", "gate_verification_event", eventId, {
    synthetic: true,
    simulated: true,
  });
  audit(session.userId, "scan.verified", "gate_verification_event", eventId, {
    outcome,
  });

  if (outcome === "human-review") {
    const reviewId = randomUUID();
    db.prepare(
      `INSERT INTO review_items (id, event_id, status) VALUES (?, ?, 'pending')`
    ).run(reviewId, eventId);
  }

  revalidatePath("/gate");
  revalidatePath("/gate/reviews");
  revalidatePath("/");
  return { ok: true, message: "Scan recorded (simulated).", outcome, reason, eventId };
}

// ── Review queue ─────────────────────────────────────────────────────────

export async function decideReviewAction(
  reviewId: string,
  decision: "approved" | "rejected",
  note: string
): Promise<ActionResult> {
  // Supervisor only — the UI also hides these buttons for other roles.
  const session = await requireRole("supervisor");
  const db = getDb();

  const row = db
    .prepare("SELECT id, event_id, status FROM review_items WHERE id = ?")
    .get(reviewId) as { id: string; event_id: string; status: string } | undefined;
  if (!row) return { ok: false, message: "Review item not found." };
  if (row.status !== "pending") {
    return { ok: false, message: `Review item already ${row.status}.` };
  }

  db.prepare(
    `UPDATE review_items
     SET status = ?, decided_by = ?, decided_at = datetime('now'), note = ?
     WHERE id = ?`
  ).run(decision, session.userId, note.trim().slice(0, 500) || null, reviewId);
  audit(session.userId, "review.decided", "review_item", reviewId, {
    decision,
    event_id: row.event_id,
  });

  revalidatePath("/gate/reviews");
  revalidatePath("/");
  return { ok: true, message: `Review ${decision}.` };
}

// ── PortTwin simulation ──────────────────────────────────────────────────

export async function createSimulationRunAction(
  prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const session = await requireRole("planner");

  const num = (v: FormDataEntryValue | null): number | undefined => {
    const s = String(v ?? "").trim();
    return s === "" ? undefined : Number(s);
  };

  const raw = {
    scenarioName: String(formData.get("scenarioName") ?? "").trim(),
    scenarioId: String(formData.get("scenarioId") ?? "").trim(),
    seed: num(formData.get("seed")),
    replications: num(formData.get("replications")),
    paramOverrides: {
      horizonHours: num(formData.get("horizonHours")),
      trucksPerDay: num(formData.get("trucksPerDay")),
      numGates: num(formData.get("numGates")),
      gateServiceMeanMin: num(formData.get("gateServiceMeanMin")),
    },
  };

  const parsed = CreateSimulationInput.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[issue.path.length - 1] ?? "scenarioId");
      fieldErrors[key] = issue.message;
    }
    return {
      ok: false,
      message: "Validation failed — fix the highlighted fields.",
      fieldErrors,
    };
  }

  const db = getDb();
  let recordId: string;
  try {
    const { record } = createSimulationRun(db, session.userId, parsed.data);
    recordId = record.id;
    audit(session.userId, "simulation.run_created", "simulation", record.id, {
      scenarioId: record.scenarioId,
      synthetic: true,
    });
  } catch (e) {
    if (e instanceof SimulationValidationError) {
      return { ok: false, message: e.publicError.message };
    }
    return { ok: false, message: "Simulation failed unexpectedly." };
  }

  revalidatePath("/simulate");
  redirect(`/simulate/runs/${recordId}`);
}
