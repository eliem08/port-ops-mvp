// End-to-end demo scenario: the canonical port-ops story told through the
// real HTTP route handlers against a fresh in-memory DB.
//   operator creates an appointment → confirms it → submits a matching
//   scan → auto-accept checks it in → dashboard reflects the counts →
//   a second low-confidence scan lands in the human-review queue →
//   a supervisor decides it → the audit trail contains every event in
//   order.
// Style: requireApiRole/getDb mocked (sessions are switched per step);
// the REAL audit module records the trail so we can assert on it.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { NextRequest } from "next/server";
import {
  resetHarness,
  allowAs,
  postJson,
  getReq,
  VIEWER,
  OPERATOR,
  SUPERVISOR,
} from "@/test-utils/route-harness";

const mocks = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  getDb: vi.fn(),
  // Real audit: asserted on below.
}));
vi.mock("@/lib/auth", () => ({
  requireApiRole: mocks.requireApiRole,
  jsonError: (status: number, code: string, message: string) =>
    new Response(JSON.stringify({ error: { code, message } }), { status }),
}));
vi.mock("@/lib/db/client", () => ({ getDb: mocks.getDb }));

import { POST as postAppointments } from "@/app/api/appointments/route";
import { GET as getAppointmentById } from "@/app/api/appointments/[id]/route";
import { PATCH as patchStatus } from "@/app/api/appointments/[id]/status/route";
import { POST as postScans } from "@/app/api/gate/scans/route";
import { GET as getReviews } from "@/app/api/gate/reviews/route";
import { POST as decideReview } from "@/app/api/gate/reviews/[id]/decide/route";
import { GET as getDashboard } from "@/app/api/dashboard/route";

let db: DatabaseSync;
beforeEach(() => {
  db = resetHarness(mocks);
});

function patchAppointmentStatus(id: string, to: string): Promise<Response> {
  return patchStatus(
    new NextRequest(`http://localhost/api/appointments/${id}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to }),
    }),
    { params: Promise.resolve({ id }) }
  );
}

describe("demo scenario: truck gate flow end to end", () => {
  it("create → confirm → scan → auto-accept → dashboard → human review → audit order", async () => {
    // 1. Operator creates the appointment.
    allowAs(mocks, OPERATOR);
    const createRes = await postAppointments(
      postJson("/api/appointments", {
        truckPlate: "DEMO-100",
        containerNo: "TCLU1000001",
        driverName: "Demo Driver",
        scheduledAt: "2026-10-20T10:00:00Z",
      })
    );
    expect(createRes.status).toBe(201);
    const appointment = await createRes.json();
    expect(appointment.status).toBe("requested");

    // 2. Operator confirms it.
    allowAs(mocks, OPERATOR);
    const confirmRes = await patchAppointmentStatus(appointment.id, "confirmed");
    expect(confirmRes.status).toBe(200);
    expect((await confirmRes.json()).status).toBe("confirmed");

    // 3. Operator submits a matching high-confidence scan → auto-accept.
    allowAs(mocks, OPERATOR);
    const scanRes = await postScans(
      postJson("/api/gate/scans", {
        appointmentId: appointment.id,
        plateRead: "DEMO-100",
        containerRead: "TCLU1000001",
        confidence: 94,
      })
    );
    expect(scanRes.status).toBe(201);
    const scan = await scanRes.json();
    expect(scan.outcome).toBe("auto-accept");
    expect(scan.reviewItemId).toBeNull();

    // 4. The appointment detail now shows checked-in.
    allowAs(mocks, VIEWER);
    const detail = await (
      await getAppointmentById(getReq(`/api/appointments/${appointment.id}`), {
        params: Promise.resolve({ id: appointment.id }),
      })
    ).json();
    expect(detail.appointment.status).toBe("checked-in");
    expect(detail.verificationHistory).toHaveLength(1);
    expect(detail.verificationHistory[0].outcome).toBe("auto-accept");

    // 5. The dashboard reflects the new state.
    allowAs(mocks, VIEWER);
    const dashboard = await (
      await getDashboard(getReq("/api/dashboard"))
    ).json();
    expect(dashboard.appointmentsByStatus["checked-in"]).toBe(1);
    expect(dashboard.totalAppointments).toBe(1);
    expect(dashboard.verificationsByOutcome["auto-accept"]).toBe(1);
    expect(dashboard.totalVerifications).toBe(1);
    expect(dashboard.pendingReviews).toBe(0);

    // 6. A second truck scans with low confidence → human-review queue.
    allowAs(mocks, OPERATOR);
    const appt2 = await (
      await postAppointments(
        postJson("/api/appointments", {
          truckPlate: "DEMO-200",
          scheduledAt: "2026-10-20T11:00:00Z",
        })
      )
    ).json();
    allowAs(mocks, OPERATOR);
    await patchAppointmentStatus(appt2.id, "confirmed");
    allowAs(mocks, OPERATOR);
    const scan2 = await (
      await postScans(
        postJson("/api/gate/scans", {
          appointmentId: appt2.id,
          plateRead: "DEMO-200",
          confidence: 25, // below the 70 review threshold
        })
      )
    ).json();
    expect(scan2.outcome).toBe("human-review");
    expect(scan2.reviewItemId).toBeTruthy();

    // 7. Supervisor sees the pending item and approves it.
    allowAs(mocks, SUPERVISOR);
    const queue = await (await getReviews(getReq("/api/gate/reviews"))).json();
    expect(queue).toHaveLength(1);
    expect(queue[0].id).toBe(scan2.reviewItemId);

    allowAs(mocks, SUPERVISOR);
    const decideRes = await decideReview(
      postJson(`/api/gate/reviews/${scan2.reviewItemId}/decide`, {
        decision: "approved",
        note: "Plate legible on second look.",
      }),
      { params: Promise.resolve({ id: scan2.reviewItemId }) }
    );
    expect(decideRes.status).toBe(200);
    expect((await decideRes.json()).status).toBe("approved");

    // Dashboard: the review queue drained, both appointments counted.
    allowAs(mocks, VIEWER);
    const dashboard2 = await (
      await getDashboard(getReq("/api/dashboard"))
    ).json();
    expect(dashboard2.pendingReviews).toBe(0);
    expect(dashboard2.totalAppointments).toBe(2);
    expect(dashboard2.appointmentsByStatus["checked-in"]).toBe(1);
    expect(dashboard2.appointmentsByStatus["confirmed"]).toBe(1);
    expect(dashboard2.verificationsByOutcome["human-review"]).toBe(1);

    // 8. The audit trail contains every event, in order, with the right actors.
    const rows = db
      .prepare("SELECT actor_id, action, entity, entity_id FROM audit_events ORDER BY rowid")
      .all() as Array<{
      actor_id: string;
      action: string;
      entity: string;
      entity_id: string;
    }>;
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual([
      "appointment.created", // DEMO-100
      "appointment.status_changed", // → confirmed
      "scan.verified", // auto-accept
      "appointment.created", // DEMO-200
      "appointment.status_changed", // → confirmed
      "scan.verified", // human-review
      "review.decided", // approved
    ]);

    const actors = rows.map((r) => r.actor_id);
    expect(actors).toEqual([
      "u-operator",
      "u-operator",
      "u-operator",
      "u-operator",
      "u-operator",
      "u-operator",
      "u-supervisor",
    ]);

    // Entity ids tie back to the real records.
    const byAction = (a: string) => rows.filter((r) => r.action === a);
    expect(byAction("appointment.created")[0].entity_id).toBe(appointment.id);
    expect(byAction("appointment.created")[1].entity_id).toBe(appt2.id);
    expect(byAction("scan.verified")[0].entity_id).toBe(scan.verification.id);
    expect(byAction("scan.verified")[1].entity_id).toBe(scan2.verification.id);
    expect(byAction("review.decided")[0].entity_id).toBe(scan2.reviewItemId);
    expect(byAction("review.decided")[0].entity).toBe("review_item");
  });
});
