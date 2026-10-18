// Appointment domain logic — shared by the API routes (and directly testable).
// DB rows are snake_case; the DTOs here are camelCase contract shapes.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  STATUS_TRANSITIONS,
  AppointmentStatus,
  type AppointmentStatus as AppointmentStatusT,
} from "@/contracts";
import { withTransaction } from "./route-helpers";

export interface AppointmentRow {
  id: string;
  truck_plate: string;
  container_no: string | null;
  driver_name: string | null;
  scheduled_at: string;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  idempotency_key: string | null;
}

export interface AppointmentDTO {
  id: string;
  truckPlate: string;
  containerNo: string | null;
  driverName: string | null;
  scheduledAt: string;
  status: AppointmentStatusT;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export function toAppointmentDTO(row: AppointmentRow): AppointmentDTO {
  return {
    id: row.id,
    truckPlate: row.truck_plate,
    containerNo: row.container_no,
    driverName: row.driver_name,
    scheduledAt: row.scheduled_at,
    status: AppointmentStatus.parse(row.status),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const APPT_COLUMNS =
  "id, truck_plate, container_no, driver_name, scheduled_at, status, created_by, created_at, updated_at, idempotency_key";

export interface CreateAppointmentInput {
  truckPlate: string;
  containerNo: string | null;
  driverName: string | null;
  scheduledAt: string;
  idempotencyKey?: string;
}

/**
 * Atomic check-and-create. The INSERT OR IGNORE into idempotency_keys inside
 * a transaction makes the existence check and the appointment insert atomic:
 * two concurrent requests with the same key can never create two appointments.
 *
 * Returns { record, created }: created=false + the EXISTING record when the
 * key was already seen (caller should answer 200, not 201).
 */
export function createAppointment(
  db: DatabaseSync,
  actorId: string,
  input: CreateAppointmentInput
): { record: AppointmentDTO; created: boolean } {
  const { row, created } = withTransaction(db, (): { row: AppointmentRow; created: boolean } => {
    if (input.idempotencyKey) {
      const claim = db
        .prepare("INSERT OR IGNORE INTO idempotency_keys (key) VALUES (?)")
        .run(input.idempotencyKey);
      if (claim.changes === 0) {
        // Key already exists → return the existing appointment, do not create.
        const existing = db
          .prepare(`SELECT ${APPT_COLUMNS} FROM appointments WHERE idempotency_key = ?`)
          .get(input.idempotencyKey) as unknown as AppointmentRow | undefined;
        if (!existing) {
          // Fail closed: key without an appointment should be impossible.
          throw new Error("idempotency key claimed but no appointment found");
        }
        return { row: existing, created: false };
      }
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO appointments
       (id, truck_plate, container_no, driver_name, scheduled_at, status, created_by, created_at, updated_at, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.truckPlate,
      input.containerNo,
      input.driverName,
      input.scheduledAt,
      "requested",
      actorId,
      now,
      now,
      input.idempotencyKey ?? null
    );
    const row = db
      .prepare(`SELECT ${APPT_COLUMNS} FROM appointments WHERE id = ?`)
      .get(id) as unknown as AppointmentRow;
    return { row, created: true };
  });

  return { record: toAppointmentDTO(row), created };
}

export function getAppointment(db: DatabaseSync, id: string): AppointmentDTO | null {
  const row = db
    .prepare(`SELECT ${APPT_COLUMNS} FROM appointments WHERE id = ?`)
    .get(id) as unknown as AppointmentRow | undefined;
  return row ? toAppointmentDTO(row) : null;
}

export function listAppointments(
  db: DatabaseSync,
  status?: AppointmentStatusT
): AppointmentDTO[] {
  const rows = status
    ? (db
        .prepare(`SELECT ${APPT_COLUMNS} FROM appointments WHERE status = ? ORDER BY created_at DESC`)
        .all(status) as unknown as AppointmentRow[])
    : (db
        .prepare(`SELECT ${APPT_COLUMNS} FROM appointments ORDER BY created_at DESC`)
        .all() as unknown as AppointmentRow[]);
  return rows.map(toAppointmentDTO);
}

export class IllegalTransitionError extends Error {
  readonly from: string;
  readonly to: AppointmentStatusT;
  constructor(from: string, to: AppointmentStatusT) {
    super(`Illegal status transition: '${from}' -> '${to}'`);
    this.from = from;
    this.to = to;
  }
}

/**
 * Transition an appointment's status, enforcing the TAS STATUS_TRANSITIONS
 * state machine. Throws IllegalTransitionError when the move is not allowed.
 */
export function setAppointmentStatus(
  db: DatabaseSync,
  id: string,
  to: AppointmentStatusT
): AppointmentDTO {
  const current = getAppointment(db, id);
  if (!current) throw new Error(`appointment not found: ${id}`);
  const allowed = STATUS_TRANSITIONS[current.status] ?? [];
  if (!allowed.includes(to)) {
    throw new IllegalTransitionError(current.status, to);
  }
  const now = new Date().toISOString();
  db.prepare("UPDATE appointments SET status = ?, updated_at = ? WHERE id = ?").run(
    to,
    now,
    id
  );
  const updated = getAppointment(db, id);
  if (!updated) throw new Error(`appointment vanished during update: ${id}`);
  return updated;
}

/** Can this appointment currently transition to 'checked-in'? (fail-closed guard for auto-accept) */
export function canCheckIn(status: AppointmentStatusT): boolean {
  return (STATUS_TRANSITIONS[status] ?? []).includes("checked-in");
}
