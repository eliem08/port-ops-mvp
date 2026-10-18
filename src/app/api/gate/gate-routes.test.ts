// Route tests for /api/gate/scans, /api/gate/reviews and
// /api/gate/reviews/[id]/decide. Mocked-auth style: the handlers, zod
// contracts and the scan-verdict logic run for real against a fresh
// in-memory DB per test.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { NextRequest } from "next/server";
import {
  resetHarness,
  allowAs,
  denyWith,
  postJson,
  getReq,
  VIEWER,
  OPERATOR,
  SUPERVISOR,
} from "@/test-utils/route-harness";

const mocks = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  getDb: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireApiRole: mocks.requireApiRole,
  jsonError: (status: number, code: string, message: string) =>
    new Response(JSON.stringify({ error: { code, message } }), { status }),
}));
vi.mock("@/lib/db/client", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));

import { POST as postScans } from "./scans/route";
import { GET as getReviews } from "./reviews/route";
import { POST as decideReview } from "./reviews/[id]/decide/route";
import { POST as postAppointments } from "@/app/api/appointments/route";
import { PATCH as patchStatus } from "@/app/api/appointments/[id]/status/route";

let db: DatabaseSync;
beforeEach(() => {
  db = resetHarness(mocks);
});

const APPT = {
  truckPlate: "CAS-4821-A",
  containerNo: "TCLU4829103",
  scheduledAt: "2026-10-20T10:00:00Z",
};

/** Appointment driven to 'confirmed' — eligible for auto-accept check-in. */
async function makeConfirmedAppointment(): Promise<string> {
  allowAs(mocks, OPERATOR);
  const created = await (
    await postAppointments(postJson("/api/appointments", APPT))
  ).json();
  const patched = await patchStatus(
    new NextRequest(`http://localhost/api/appointments/${created.id}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "confirmed" }),
    }),
    { params: Promise.resolve({ id: created.id }) }
  );
  expect(patched.status).toBe(200);
  return created.id as string;
}

function submitScanAs(
  session: typeof OPERATOR,
  body: unknown
): Promise<Response> {
  allowAs(mocks, session);
  return postScans(postJson("/api/gate/scans", body));
}

function scanCount(): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM gate_verification_events")
      .get() as { n: number }
  ).n;
}

// ── POST /api/gate/scans ─────────────────────────────────────────────────

describe("POST /api/gate/scans", () => {
  it("401 when unauthenticated", async () => {
    denyWith(mocks, 401, "unauthenticated");
    const res = await postScans(
      postJson("/api/gate/scans", { appointmentId: "x" })
    );
    expect(res.status).toBe(401);
  });

  it("403 when the role is operations_viewer (operator required)", async () => {
    denyWith(mocks, 403, "forbidden");
    const res = await postScans(
      postJson("/api/gate/scans", { appointmentId: "x" })
    );
    expect(res.status).toBe(403);
    expect(scanCount()).toBe(0);
  });

  it("201 auto-accept when the scan matches a confirmed appointment with high confidence", async () => {
    const appointmentId = await makeConfirmedAppointment();
    const res = await submitScanAs(OPERATOR, {
      appointmentId,
      plateRead: "CAS-4821-A",
      containerRead: "TCLU4829103",
      confidence: 90,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.outcome).toBe("auto-accept");
    expect(body.verification.outcome).toBe("auto-accept");
    expect(body.verification.simulated).toBe(true);
    expect(body.reviewItemId).toBeNull();

    // Auto-accept checked the appointment in through the state machine.
    const row = db
      .prepare("SELECT status FROM appointments WHERE id = ?")
      .get(appointmentId) as { status: string };
    expect(row.status).toBe("checked-in");

    expect(mocks.audit).toHaveBeenCalledWith(
      "u-operator",
      "scan.verified",
      "gate_verification_event",
      body.verification.id,
      expect.objectContaining({ outcome: "auto-accept", autoAccepted: true })
    );
  });

  it("201 human-review + review item when confidence is below the threshold", async () => {
    const appointmentId = await makeConfirmedAppointment();
    const res = await submitScanAs(OPERATOR, {
      appointmentId,
      plateRead: "CAS-4821-A",
      containerRead: "TCLU4829103",
      confidence: 50, // below DEFAULT_REVIEW_THRESHOLD (70)
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.outcome).toBe("human-review");
    expect(body.reviewItemId).toBeTruthy();

    const review = db
      .prepare("SELECT status FROM review_items WHERE id = ?")
      .get(body.reviewItemId) as { status: string };
    expect(review.status).toBe("pending");

    // Low-confidence scan must NOT check the appointment in.
    const row = db
      .prepare("SELECT status FROM appointments WHERE id = ?")
      .get(appointmentId) as { status: string };
    expect(row.status).toBe("confirmed");
  });

  it("201 human-review when the plate does not match (fail-closed on mismatch)", async () => {
    const appointmentId = await makeConfirmedAppointment();
    const res = await submitScanAs(OPERATOR, {
      appointmentId,
      plateRead: "WRONG-PLATE",
      containerRead: "TCLU4829103",
      confidence: 95,
    });
    expect((await res.json()).outcome).toBe("human-review");
  });

  it("201 scan-failed when both reads are empty", async () => {
    const appointmentId = await makeConfirmedAppointment();
    const res = await submitScanAs(OPERATOR, {
      appointmentId,
      confidence: 90,
    });
    const body = await res.json();
    expect(body.outcome).toBe("scan-failed");
    expect(body.reviewItemId).toBeNull();
  });

  it("missing confidence fails closed to human-review (never auto-accept)", async () => {
    const appointmentId = await makeConfirmedAppointment();
    const res = await submitScanAs(OPERATOR, {
      appointmentId,
      plateRead: "CAS-4821-A",
      containerRead: "TCLU4829103",
      // no confidence
    });
    expect((await res.json()).outcome).toBe("human-review");
  });

  it("out-of-range confidence (e.g. 101) fails closed to human-review", async () => {
    const appointmentId = await makeConfirmedAppointment();
    const res = await submitScanAs(OPERATOR, {
      appointmentId,
      plateRead: "CAS-4821-A",
      containerRead: "TCLU4829103",
      confidence: 101,
    });
    expect((await res.json()).outcome).toBe("human-review");
  });

  it("scan against a non-check-in-eligible status → human-review (machine gates auto-accept)", async () => {
    // Appointment left in 'requested' — cannot move to checked-in.
    allowAs(mocks, OPERATOR);
    const created = await (
      await postAppointments(postJson("/api/appointments", APPT))
    ).json();
    const res = await submitScanAs(OPERATOR, {
      appointmentId: created.id,
      plateRead: "CAS-4821-A",
      containerRead: "TCLU4829103",
      confidence: 95,
    });
    expect((await res.json()).outcome).toBe("human-review");
  });

  it("404 for an unknown appointmentId", async () => {
    const res = await submitScanAs(OPERATOR, {
      appointmentId: "00000000-0000-4000-8000-000000000001",
      plateRead: "X",
      confidence: 90,
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("400 on invalid input (bad uuid / extra field)", async () => {
    for (const body of [
      { appointmentId: "not-a-uuid", confidence: 90 },
      {
        appointmentId: "00000000-0000-4000-8000-000000000001",
        confidence: 90,
        extra: 1,
      },
    ]) {
      const res = await submitScanAs(OPERATOR, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("validation_error");
    }
  });

  it("400 on malformed JSON", async () => {
    allowAs(mocks, OPERATOR);
    const req = new NextRequest("http://localhost/api/gate/scans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const res = await postScans(req);
    expect(res.status).toBe(400);
  });
});

// ── GET /api/gate/reviews ────────────────────────────────────────────────

describe("GET /api/gate/reviews", () => {
  it("401 when unauthenticated", async () => {
    denyWith(mocks, 401, "unauthenticated");
    const res = await getReviews(getReq("/api/gate/reviews"));
    expect(res.status).toBe(401);
  });

  it("200 with pending review items for a viewer; excludes decided ones", async () => {
    const appointmentId = await makeConfirmedAppointment();
    allowAs(mocks, OPERATOR);
    const scanned = await (
      await postScans(
        postJson("/api/gate/scans", {
          appointmentId,
          plateRead: "CAS-4821-A",
          containerRead: "TCLU4829103",
          confidence: 40,
        })
      )
    ).json();
    const reviewId = scanned.reviewItemId as string;

    allowAs(mocks, VIEWER);
    const res = await getReviews(getReq("/api/gate/reviews"));
    expect(res.status).toBe(200);
    const items = await res.json();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(reviewId);
    expect(items[0].status).toBe("pending");
    expect(items[0].event.appointmentId).toBe(appointmentId);
    expect(items[0].appointment.truckPlate).toBe("CAS-4821-A");

    // Decide it as a supervisor; the pending queue drains.
    allowAs(mocks, SUPERVISOR);
    const decided = await decideReview(
      postJson(`/api/gate/reviews/${reviewId}/decide`, { decision: "approved" }),
      { params: Promise.resolve({ id: reviewId }) }
    );
    expect(decided.status).toBe(200);

    allowAs(mocks, VIEWER);
    const after = await getReviews(getReq("/api/gate/reviews"));
    expect(await after.json()).toHaveLength(0);
  });

  it("200 empty list when nothing is pending", async () => {
    allowAs(mocks, VIEWER);
    const res = await getReviews(getReq("/api/gate/reviews"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

// ── POST /api/gate/reviews/[id]/decide ───────────────────────────────────

describe("POST /api/gate/reviews/[id]/decide", () => {
  /** Low-confidence scan → pending review item, submitted by OPERATOR. */
  async function makePendingReview(): Promise<string> {
    const appointmentId = await makeConfirmedAppointment();
    allowAs(mocks, OPERATOR);
    const body = await (
      await postScans(
        postJson("/api/gate/scans", {
          appointmentId,
          plateRead: "CAS-4821-A",
          containerRead: "TCLU4829103",
          confidence: 30,
        })
      )
    ).json();
    return body.reviewItemId as string;
  }

  function decideAs(
    session: typeof SUPERVISOR,
    id: string,
    body: unknown
  ): Promise<Response> {
    allowAs(mocks, session);
    return decideReview(
      postJson(`/api/gate/reviews/${id}/decide`, body),
      { params: Promise.resolve({ id }) }
    );
  }

  it("401 when unauthenticated", async () => {
    denyWith(mocks, 401, "unauthenticated");
    const res = await decideReview(
      postJson("/api/gate/reviews/x/decide", { decision: "approved" }),
      { params: Promise.resolve({ id: "x" }) }
    );
    expect(res.status).toBe(401);
  });

  it("403 when the role is below supervisor (operator cannot decide)", async () => {
    denyWith(mocks, 403, "forbidden");
    const reviewId = await makePendingReview();
    const res = await decideReview(
      postJson(`/api/gate/reviews/${reviewId}/decide`, { decision: "approved" }),
      { params: Promise.resolve({ id: reviewId }) }
    );
    expect(res.status).toBe(403);
  });

  it("200 on approve; audits review.decided", async () => {
    const reviewId = await makePendingReview();
    const res = await decideAs(SUPERVISOR, reviewId, {
      decision: "approved",
      note: "Reads verified against the manifest.",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("approved");
    expect(body.decidedBy).toBe("u-supervisor");
    expect(body.note).toBe("Reads verified against the manifest.");
    expect(mocks.audit).toHaveBeenCalledWith(
      "u-supervisor",
      "review.decided",
      "review_item",
      reviewId,
      { decision: "approved" }
    );
  });

  it("200 on reject", async () => {
    const reviewId = await makePendingReview();
    const res = await decideAs(SUPERVISOR, reviewId, { decision: "rejected" });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("rejected");
  });

  it("403 separation_of_duties: cannot decide your own scan's review", async () => {
    const reviewId = await makePendingReview();
    // Same user id as the scan submitter, but wearing a supervisor hat.
    const sameUserSupervisor = {
      ...SUPERVISOR,
      userId: OPERATOR.userId,
    };
    const res = await decideAs(sameUserSupervisor, reviewId, {
      decision: "approved",
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("separation_of_duties");
  });

  it("409 when the item was already decided", async () => {
    const reviewId = await makePendingReview();
    expect((await decideAs(SUPERVISOR, reviewId, { decision: "approved" })).status).toBe(200);
    const second = await decideAs(SUPERVISOR, reviewId, { decision: "rejected" });
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe("already_decided");
  });

  it("404 for an unknown review id", async () => {
    const res = await decideAs(SUPERVISOR, "does-not-exist", {
      decision: "approved",
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("400 on invalid decision / extra field", async () => {
    const reviewId = await makePendingReview();
    for (const body of [
      { decision: "maybe" },
      { decision: "approved", extra: 1 },
      {},
    ]) {
      const res = await decideAs(SUPERVISOR, reviewId, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("validation_error");
    }
    // Item still pending after the rejected attempts.
    const row = db
      .prepare("SELECT status FROM review_items WHERE id = ?")
      .get(reviewId) as { status: string };
    expect(row.status).toBe("pending");
  });
});
