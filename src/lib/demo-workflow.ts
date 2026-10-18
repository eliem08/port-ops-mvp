// Cross-module demo workflow domain logic (server-callable, session-free).
//
// One explicit end-to-end chain, no fake integration:
//
//   appointment (TAS CRUD + state machine)
//     → simulated gate scan verified against the SERVER's authoritative
//       appointment row (GateWatch verifyGateEventAgainstAppointment)
//     → uncertain scans routed to a human review queue (supervisor decides)
//     → EXPLICIT, operator-editable bridge: appointment volume on a date is
//       turned into PortTwin simulation overrides, with every assumption
//       shown and editable — nothing feeds the simulator automatically
//     → baseline vs proposed run comparison via compareSimulationRuns
//
// The UI server actions in ./actions.ts delegate to these functions; the
// integration test (demo-workflow.test.ts) drives the same functions
// directly, so the tested path IS the shipped path.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTransaction } from "./route-helpers";
import { canCheckIn, setAppointmentStatus } from "./appointments";
import {
  AppointmentStatus,
  type AppointmentStatus as AppointmentStatusT,
} from "@/contracts";
import { verifyGateEventAgainstAppointment } from "@/vendored/gatewatch/verify";

/* ------------------------------------------------------------------ */
/* Simulated gate scans (GateWatch, server-side appointment state)     */
/* ------------------------------------------------------------------ */

export interface ScanVerificationInput {
  appointmentId: string;
  plateRead: string | null;
  containerRead: string | null;
  /** 0-100. null / NaN / out-of-range NEVER auto-accepts (fail closed). */
  confidence: number | null;
}

export interface RecordedScan {
  eventId: string;
  outcome: "auto-accept" | "human-review" | "scan-failed";
  reasonCodes: string[];
  reviewId: string | null;
  /** True when the scan checked the appointment in (auto-accept path). */
  checkedIn: boolean;
  /**
   * Human-readable note for outcomes the vendored reason codes don't cover
   * (e.g. the auto-accept → human-review downgrade when the appointment
   * cannot legally check in). Also persisted into the event reason.
   */
  note: string | null;
}

interface AppointmentForScan {
  id: string;
  truck_plate: string;
  container_no: string | null;
  scheduled_at: string;
  status: string;
}

/**
 * Verify a simulated gate scan against the server's authoritative
 * appointment row and persist the verification event. Returns the review
 * item id when the scan was routed to a human.
 *
 * The demo slot window is scheduled_at ± 1 h and the gate is DEMO-GATE —
 * both are documented limitations, not hidden plumbing (see docs/LIMITATIONS.md).
 */
export async function recordScanVerification(
  db: DatabaseSync,
  verifiedBy: string,
  input: ScanVerificationInput
): Promise<RecordedScan> {
  const appt = db
    .prepare(
      "SELECT id, truck_plate, container_no, scheduled_at, status FROM appointments WHERE id = ?"
    )
    .get(input.appointmentId) as AppointmentForScan | undefined;
  if (!appt) throw new Error("appointment not found");

  const scannedAt = new Date();
  const slotStart = new Date(new Date(appt.scheduled_at).getTime() - 60 * 60_000);
  const slotEnd = new Date(new Date(appt.scheduled_at).getTime() + 60 * 60_000);
  const conf =
    input.confidence === null || Number.isNaN(input.confidence)
      ? Number.NaN
      : input.confidence;

  const decision = verifyGateEventAgainstAppointment(
    {
      plate: input.plateRead ?? "",
      containerNumber: input.containerRead ?? "",
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

  let outcome =
    decision.decision === "authorized"
      ? ("auto-accept" as const)
      : decision.decision === "manual-review"
        ? ("human-review" as const)
        : ("scan-failed" as const);

  // Auto-accept implies a check-in transition — the TAS state machine gates
  // it (parity with POST /api/gate/scans). An appointment that cannot
  // legally check in (e.g. already checked-in — verify() lets confirmed AND
  // checked-in through) degrades to human review instead of erroring.
  // A corrupt status string fails closed to human review as well.
  let checkedIn = false;
  let note: string | null = null;
  if (outcome === "auto-accept") {
    const statusParsed = AppointmentStatus.safeParse(appt.status);
    if (statusParsed.success && canCheckIn(statusParsed.data)) {
      checkedIn = true;
    } else {
      outcome = "human-review";
      note = `Appointment is '${appt.status}' and cannot transition to checked-in.`;
    }
  }

  const eventId = randomUUID();
  const reviewId = outcome === "human-review" ? randomUUID() : null;
  const reasonText = note
    ? [...decision.reasonCodes, note].join("; ")
    : decision.reasonCodes.join("; ");

  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO gate_verification_events
       (id, appointment_id, simulated, plate_read, container_read, confidence, outcome, reason, verified_by)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`
    ).run(
      eventId,
      input.appointmentId,
      input.plateRead,
      input.containerRead,
      Number.isFinite(conf) ? conf : null,
      outcome,
      reasonText,
      verifiedBy
    );
    if (reviewId) {
      db.prepare(
        "INSERT INTO review_items (id, event_id, status) VALUES (?, ?, 'pending')"
      ).run(reviewId, eventId);
    }
    if (checkedIn) {
      // Re-validated against STATUS_TRANSITIONS inside; a concurrent status
      // change aborts the whole transaction (fail closed, no partial write).
      setAppointmentStatus(db, input.appointmentId, "checked-in");
    }
  });

  return {
    eventId,
    outcome,
    reasonCodes: decision.reasonCodes,
    reviewId,
    checkedIn,
    note,
  };
}

/* ------------------------------------------------------------------ */
/* Human review (supervisor decision + audit trail)                    */
/* ------------------------------------------------------------------ */

export interface ReviewDecision {
  reviewId: string;
  eventId: string;
  status: "approved" | "rejected";
  decidedBy: string;
}

/**
 * Runtime-validated decision input. Server-action arguments cross the
 * network — the TypeScript signature does not survive, so a hostile caller
 * can pass ANY value for `decision`. Without this schema, `decision:
 * "pending"` (or any string) would be written straight into
 * review_items.status, corrupting the review state machine.
 */
const DecideReviewItemInput = z.object({
  reviewId: z.string().min(1).max(128),
  decidedBy: z.string().min(1).max(128),
  decision: z.enum(["approved", "rejected"]),
  note: z.string().max(500),
});

/** Approve or reject a pending review item. Second decision is rejected. */
export function decideReviewItem(
  db: DatabaseSync,
  reviewId: string,
  decidedBy: string,
  decision: "approved" | "rejected",
  note: string
): ReviewDecision {
  const parsed = DecideReviewItemInput.safeParse({
    reviewId,
    decidedBy,
    decision,
    note,
  });
  if (!parsed.success) throw new Error("invalid review decision input");

  const row = db
    .prepare("SELECT id, event_id, status FROM review_items WHERE id = ?")
    .get(parsed.data.reviewId) as
    | { id: string; event_id: string; status: string }
    | undefined;
  if (!row) throw new Error("review item not found");
  if (row.status !== "pending") {
    throw new Error(`review item already ${row.status}`);
  }

  // SEPARATION OF DUTIES (parity with POST /api/gate/reviews/[id]/decide):
  // the supervisor who submitted the scan cannot decide its review.
  const event = db
    .prepare("SELECT verified_by FROM gate_verification_events WHERE id = ?")
    .get(row.event_id) as { verified_by: string } | undefined;
  if (!event) throw new Error("originating scan record is missing");
  if (event.verified_by === parsed.data.decidedBy) {
    throw new Error(
      "separation of duties: cannot decide a review for a scan you submitted"
    );
  }

  db.prepare(
    `UPDATE review_items
     SET status = ?, decided_by = ?, decided_at = datetime('now'), note = ?
     WHERE id = ?`
  ).run(
    parsed.data.decision,
    parsed.data.decidedBy,
    parsed.data.note.trim().slice(0, 500) || null,
    parsed.data.reviewId
  );
  return {
    reviewId: row.id,
    eventId: row.event_id,
    status: parsed.data.decision,
    decidedBy: parsed.data.decidedBy,
  };
}

/* ------------------------------------------------------------------ */
/* Explicit bridge: appointment volume → PortTwin simulation overrides */
/* ------------------------------------------------------------------ */

/**
 * The appointment statuses that count as "booked truck volume" for the
 * bridge. Cancelled / no-show appointments contribute 0 trucks.
 */
export const BRIDGE_BOOKED_STATUSES: AppointmentStatusT[] = [
  "requested",
  "confirmed",
  "checked-in",
  "completed",
];

export interface AppointmentVolumeSummary {
  /** UTC calendar date the summary was computed for (YYYY-MM-DD). */
  date: string;
  total: number;
  byStatus: Record<AppointmentStatusT, number>;
  /** Appointments in a booked status (see BRIDGE_BOOKED_STATUSES). */
  booked: number;
}

const ALL_STATUSES: AppointmentStatusT[] = [
  "requested",
  "confirmed",
  "checked-in",
  "completed",
  "cancelled",
  "no-show",
];

/** Count appointments whose scheduled_at falls on the UTC date YYYY-MM-DD. */
export function appointmentVolumeSummary(
  db: DatabaseSync,
  date: string
): AppointmentVolumeSummary {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`date must be YYYY-MM-DD, got '${date}'`);
  }
  const byStatus = Object.fromEntries(
    ALL_STATUSES.map((s) => [s, 0])
  ) as Record<AppointmentStatusT, number>;
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS c FROM appointments
       WHERE substr(scheduled_at, 1, 10) = ?
       GROUP BY status`
    )
    .all(date) as Array<{ status: string; c: number }>;
  let total = 0;
  for (const r of rows) {
    const s = r.status as AppointmentStatusT;
    if (s in byStatus) {
      byStatus[s] = r.c;
      total += r.c;
    }
  }
  const booked = BRIDGE_BOOKED_STATUSES.reduce((n, s) => n + byStatus[s], 0);
  return { date, total, byStatus, booked };
}

export interface SimulationBridgeProposal {
  scenarioName: string;
  /** Proposed PortTwin trucksPerDay override — derived from `booked`. */
  trucksPerDay: number;
  horizonHours: number;
  /**
   * Explicit, operator-editable assumptions. The first line states the
   * derivation; LIMIT lines state what the bridge does NOT model. Nothing
   * here is automatic — the UI presents these for editing before the run.
   */
  assumptions: string[];
}

/**
 * Propose an explicit appointment→simulation bridge from a volume summary.
 * Pure function: the derivation is visible in the assumptions, and the
 * returned values are defaults for the operator to edit, not a hidden feed.
 */
export function proposeSimulationBridge(
  summary: AppointmentVolumeSummary
): SimulationBridgeProposal {
  const { date, total, booked } = summary;
  const excluded = total - booked;
  // The contract requires trucksPerDay ≥ 1. A zero-volume day pre-fills 1
  // and SAYS SO — it does not silently invent traffic.
  const trucksPerDay = Math.max(booked, 1);
  const assumptions: string[] = [
    "APPOINTMENT→SIMULATION BRIDGE — explicit and operator-editable. Appointments do NOT feed the simulator automatically; this run overrides the chosen preset ONLY as stated below.",
    `Bridge derivation: trucksPerDay = ${trucksPerDay}, from ${booked} booked appointment(s) (statuses: requested, confirmed, checked-in, completed) scheduled for ${date} — synthetic TAS demo data.`,
  ];
  if (booked === 0) {
    assumptions.push(
      `Zero-volume day: no booked appointments on ${date}; trucksPerDay pre-filled to 1 (the smallest value the input contract accepts). Edit this value before running.`
    );
  }
  if (excluded > 0) {
    assumptions.push(
      `Excluded from the bridge: ${excluded} appointment(s) on ${date} in cancelled / no-show status contribute 0 trucks.`
    );
  }
  assumptions.push(
    "Bridge derivation: horizonHours = 24 (one operating day). Every other PortTwin engine input comes from the chosen scenario preset unchanged.",
    "LIMIT — PortTwin does not model appointment slots, terminals, gates by carrier, or no-show behaviour. This bridge maps only total daily truck volume, not the appointment structure.",
    "LIMIT — appointments carry no cargo/dwell data; the simulator's synthetic cargo mix is untouched.",
    "DATA — all appointment data is synthetic demo data; the simulation is UNCALIBRATED."
  );
  return {
    scenarioName: `BRIDGE — ${date} appointment volume (${booked} booked trucks)`,
    trucksPerDay,
    horizonHours: 24,
    assumptions,
  };
}
