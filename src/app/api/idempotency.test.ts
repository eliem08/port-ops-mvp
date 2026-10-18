// Idempotency semantics across the write routes.
// - POST /api/appointments with the same idempotencyKey → same record,
//   no duplicate, second call answers 200.
// - POST /api/planning/runs with the same content → same run (content
//   hash + solver), replayed rather than recomputed, 200.
// - POST /api/gate/scans is NOT idempotent BY DESIGN: every scan is a
//   distinct verification EVENT (an operator may rescan the same truck).
//   Retries therefore create a second event — callers that need
//   exactly-once semantics must dedupe on their side (e.g. by comparing
//   event.createdAt / id before retrying).

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  resetHarness,
  allowAs,
  postJson,
  OPERATOR,
  PLANNER,
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

import { POST as postAppointments } from "./appointments/route";
import { POST as postPlanRuns } from "./planning/runs/route";
import { POST as postScans } from "./gate/scans/route";
import { PATCH as patchStatus } from "./appointments/[id]/status/route";
import { NextRequest } from "next/server";

let db: DatabaseSync;
beforeEach(() => {
  db = resetHarness(mocks);
});

const APPT_BODY = {
  truckPlate: "IDEM-1",
  containerNo: "TCLU4829103",
  scheduledAt: "2026-10-20T10:00:00Z",
  idempotencyKey: "idem-appointment-xyz-001",
};

const PLAN_BODY = {
  scenarioName: "idempotency plan",
  vessels: [
    {
      name: "SYN I1",
      lengthM: 200,
      draftM: 10,
      eta: "2026-10-20T06:00:00Z",
      etd: "2026-10-20T14:00:00Z",
      grainCapable: false,
    },
  ],
  berths: [{ name: "SYN IQ1", lengthM: 300, maxDraftM: 14, grainCapable: false }],
  solver: "greedy",
  seed: 42,
};

describe("appointment idempotency (explicit idempotencyKey)", () => {
  it("second POST with the same key returns the SAME record, no duplicate", async () => {
    allowAs(mocks, OPERATOR);
    const first = await postAppointments(
      postJson("/api/appointments", APPT_BODY)
    );
    expect(first.status).toBe(201);
    const created = await first.json();

    allowAs(mocks, OPERATOR);
    const second = await postAppointments(
      postJson("/api/appointments", APPT_BODY)
    );
    expect(second.status).toBe(200);
    const replayed = await second.json();
    expect(replayed.id).toBe(created.id);
    expect(replayed).toEqual(created);

    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM appointments").get() as { n: number }
    ).n;
    expect(n).toBe(1);

    // The replay is audited as a replay, not as a new creation.
    const replayAudit = mocks.audit.mock.calls.find(
      (c) => c[1] === "appointment.created" && c[4]?.idempotentReplay === true
    );
    expect(replayAudit?.[3]).toBe(created.id);
  });

  it("different keys create different appointments", async () => {
    allowAs(mocks, OPERATOR);
    const a = await (
      await postAppointments(
        postJson("/api/appointments", {
          ...APPT_BODY,
          idempotencyKey: "idem-appointment-xyz-002",
        })
      )
    ).json();
    const b = await (
      await postAppointments(
        postJson("/api/appointments", {
          ...APPT_BODY,
          idempotencyKey: "idem-appointment-xyz-003",
        })
      )
    ).json();
    expect(a.id).not.toBe(b.id);
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM appointments").get() as { n: number }
    ).n;
    expect(n).toBe(2);
  });

  it("replay preserves the original record even after mutations", async () => {
    allowAs(mocks, OPERATOR);
    const created = await (
      await postAppointments(postJson("/api/appointments", APPT_BODY))
    ).json();
    // Mutate the record (confirm it).
    allowAs(mocks, OPERATOR);
    await patchStatus(
      new NextRequest(
        `http://localhost/api/appointments/${created.id}/status`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to: "confirmed" }),
        }
      ),
      { params: Promise.resolve({ id: created.id }) }
    );
    // The replay returns the CURRENT record — same id, latest state.
    allowAs(mocks, OPERATOR);
    const replayed = await (
      await postAppointments(postJson("/api/appointments", APPT_BODY))
    ).json();
    expect(replayed.id).toBe(created.id);
    expect(replayed.status).toBe("confirmed");
  });
});

describe("planning run idempotency (content hash + solver)", () => {
  it("same content twice → 201 then 200 with the same run id", async () => {
    allowAs(mocks, PLANNER);
    const first = await postPlanRuns(postJson("/api/planning/runs", PLAN_BODY));
    expect(first.status).toBe(201);
    const created = await first.json();

    allowAs(mocks, PLANNER);
    const second = await postPlanRuns(
      postJson("/api/planning/runs", PLAN_BODY)
    );
    expect(second.status).toBe(200);
    const replayed = await second.json();
    expect(replayed.id).toBe(created.id);

    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM berth_plans").get() as { n: number }
    ).n;
    expect(n).toBe(1);

    expect(mocks.audit).toHaveBeenCalledWith(
      "u-planner",
      "planning.run_created",
      "berth_plan",
      created.id,
      expect.objectContaining({ idempotentReplay: true })
    );
  });

  it("same content with a different solver → a NEW run", async () => {
    allowAs(mocks, PLANNER);
    const greedy = await (
      await postPlanRuns(postJson("/api/planning/runs", PLAN_BODY))
    ).json();
    const annealing = await (
      await postPlanRuns(
        postJson("/api/planning/runs", { ...PLAN_BODY, solver: "annealing" })
      )
    ).json();
    expect(annealing.id).not.toBe(greedy.id);
  });
});

describe("gate scans are NOT idempotent (by design)", () => {
  it("two identical scan submissions create TWO events — each scan is an event", async () => {
    // BY DESIGN: a rescan of the same truck is a new physical observation,
    // so the API records every submission. Exactly-once callers must dedupe
    // client-side (the response carries the event id + createdAt).
    allowAs(mocks, OPERATOR);
    const created = await (
      await postAppointments(
        postJson("/api/appointments", {
          truckPlate: "SCAN-1",
          scheduledAt: "2026-10-20T10:00:00Z",
        })
      )
    ).json();
    await patchStatus(
      new NextRequest(
        `http://localhost/api/appointments/${created.id}/status`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to: "confirmed" }),
        }
      ),
      { params: Promise.resolve({ id: created.id }) }
    );

    const scanBody = {
      appointmentId: created.id,
      plateRead: "SCAN-1",
      confidence: 95,
    };
    allowAs(mocks, OPERATOR);
    const first = await (
      await postScans(postJson("/api/gate/scans", scanBody))
    ).json();
    const second = await (
      await postScans(postJson("/api/gate/scans", scanBody))
    ).json();

    expect(first.outcome).toBe("auto-accept");
    expect(second.verification.id).not.toBe(first.verification.id);
    const n = (
      db
        .prepare("SELECT COUNT(*) AS n FROM gate_verification_events")
        .get() as { n: number }
    ).n;
    expect(n).toBe(2);
  });
});
