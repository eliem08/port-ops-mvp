// Exhaustive tests for the TAS appointment status state machine.
// Drives setAppointmentStatus (the single choke point the status route
// uses) through the full 6x6 from/to matrix and asserts the outcome
// matches the STATUS_TRANSITIONS contract exactly.

import { describe, it, expect, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { freshTestDb } from "@/test-utils/route-harness";
import {
  STATUS_TRANSITIONS,
  AppointmentStatus,
  type AppointmentStatus as AppointmentStatusT,
} from "@/contracts";
import {
  createAppointment,
  setAppointmentStatus,
  IllegalTransitionError,
} from "./appointments";

let db: DatabaseSync;

beforeEach(() => {
  db = freshTestDb();
});

/** Create an appointment forced into `status` (setup-only; bypasses the
 *  machine via SQL — the transitions under test always go through
 *  setAppointmentStatus). */
function appointmentAt(status: AppointmentStatusT): string {
  const { record } = createAppointment(db, "u-test", {
    truckPlate: "SM-1",
    containerNo: null,
    driverName: null,
    scheduledAt: "2026-10-20T10:00:00Z",
  });
  db.prepare("UPDATE appointments SET status = ? WHERE id = ?").run(
    status,
    record.id
  );
  return record.id;
}

function statusOf(id: string): AppointmentStatusT {
  return (
    db.prepare("SELECT status FROM appointments WHERE id = ?").get(id) as {
      status: AppointmentStatusT;
    }
  ).status;
}

describe("STATUS_TRANSITIONS contract shape", () => {
  it("covers every status in the AppointmentStatus enum", () => {
    expect(Object.keys(STATUS_TRANSITIONS).sort()).toEqual(
      [...AppointmentStatus.options].sort()
    );
  });

  it("lists only valid statuses as targets", () => {
    for (const [from, tos] of Object.entries(STATUS_TRANSITIONS)) {
      for (const to of tos) {
        expect(
          AppointmentStatus.options,
          `illegal target '${to}' listed for '${from}'`
        ).toContain(to);
      }
    }
  });

  it("terminal statuses have no outgoing transitions", () => {
    for (const s of ["completed", "cancelled", "no-show"] as const) {
      expect(STATUS_TRANSITIONS[s]).toEqual([]);
    }
  });
});

describe("setAppointmentStatus — full transition matrix", () => {
  it.each(
    AppointmentStatus.options.flatMap((from) =>
      AppointmentStatus.options.map((to) => ({
        from,
        to,
        legal: STATUS_TRANSITIONS[from].includes(to),
      }))
    )
  )("$from → $to is ${legal ? 'allowed' : 'rejected'}", ({ from, to, legal }) => {
    const id = appointmentAt(from);
    if (legal) {
      const updated = setAppointmentStatus(db, id, to);
      expect(updated.status).toBe(to);
      expect(statusOf(id)).toBe(to);
    } else {
      expect(() => setAppointmentStatus(db, id, to)).toThrow(
        IllegalTransitionError
      );
      // The failed transition leaves the status untouched.
      expect(statusOf(id)).toBe(from);
    }
  });

  it("throws a descriptive IllegalTransitionError carrying from/to", () => {
    const id = appointmentAt("requested");
    try {
      setAppointmentStatus(db, id, "completed");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalTransitionError);
      const e = err as IllegalTransitionError;
      expect(e.from).toBe("requested");
      expect(e.to).toBe("completed");
      expect(e.message).toContain("requested");
      expect(e.message).toContain("completed");
    }
  });

  it("throws for an unknown appointment id", () => {
    expect(() => setAppointmentStatus(db, "nope", "confirmed")).toThrow(
      /appointment not found/
    );
  });

  it("the canonical demo flows walk the machine end to end", () => {
    const id = appointmentAt("requested");
    for (const to of ["confirmed", "checked-in", "completed"] as const) {
      setAppointmentStatus(db, id, to);
      expect(statusOf(id)).toBe(to);
    }
    // And a cancellation branch.
    const id2 = appointmentAt("confirmed");
    setAppointmentStatus(db, id2, "cancelled");
    expect(statusOf(id2)).toBe("cancelled");
    // And the no-show branch (checked-in → no-show).
    const id3 = appointmentAt("checked-in");
    setAppointmentStatus(db, id3, "no-show");
    expect(statusOf(id3)).toBe("no-show");
  });
});
