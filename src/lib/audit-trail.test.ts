// Audit trail tests.
// Every mutation route must write an audit event carrying actor, action,
// entity and entityId. The trail is append-only: there is NO API surface
// that updates or deletes audit rows, and a static guard below fails the
// suite if one is ever introduced.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import {
  resetHarness,
  allowAs,
  postJson,
  OPERATOR,
  PLANNER,
  SUPERVISOR,
} from "@/test-utils/route-harness";

const mocks = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  getDb: vi.fn(),
  // NOTE: audit is NOT mocked here — the real audit() writes to the
  // in-memory DB so we can assert on the actual trail.
}));
vi.mock("@/lib/auth", () => ({
  requireApiRole: mocks.requireApiRole,
  jsonError: (status: number, code: string, message: string) =>
    new Response(JSON.stringify({ error: { code, message } }), { status }),
}));
vi.mock("@/lib/db/client", () => ({ getDb: mocks.getDb }));

import { POST as postAppointments } from "@/app/api/appointments/route";
import { PATCH as patchStatus } from "@/app/api/appointments/[id]/status/route";
import { POST as postScans } from "@/app/api/gate/scans/route";
import { POST as decideReview } from "@/app/api/gate/reviews/[id]/decide/route";
import { POST as postPlanRuns } from "@/app/api/planning/runs/route";
import { POST as postSimRuns } from "@/app/api/simulate/runs/route";

let db: DatabaseSync;
beforeEach(() => {
  db = resetHarness(mocks);
});

interface AuditRow {
  id: string;
  actor_id: string;
  action: string;
  entity: string;
  entity_id: string;
  detail_json: string;
  created_at: string;
}

function trail(): AuditRow[] {
  return db
    .prepare("SELECT * FROM audit_events ORDER BY rowid")
    .all() as unknown as AuditRow[];
}

function auditCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n;
}

async function confirmedAppointment(): Promise<string> {
  allowAs(mocks, OPERATOR);
  const created = await (
    await postAppointments(
      postJson("/api/appointments", {
        truckPlate: "AUD-1",
        containerNo: "TCLU4829103",
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
  return created.id as string;
}

const PLAN_BODY = {
  scenarioName: "audit plan",
  vessels: [
    {
      name: "SYN A1",
      lengthM: 200,
      draftM: 10,
      eta: "2026-10-20T06:00:00Z",
      etd: "2026-10-20T14:00:00Z",
      grainCapable: false,
    },
  ],
  berths: [{ name: "SYN AQ1", lengthM: 300, maxDraftM: 14, grainCapable: false }],
  solver: "greedy",
  seed: 42,
};

describe("every mutation writes a well-formed audit event", () => {
  it("appointment.created with actor, entity and entityId", async () => {
    allowAs(mocks, OPERATOR);
    const created = await (
      await postAppointments(
        postJson("/api/appointments", {
          truckPlate: "AUD-2",
          scheduledAt: "2026-10-20T10:00:00Z",
        })
      )
    ).json();

    const rows = trail().filter((r) => r.action === "appointment.created");
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe("u-operator");
    expect(rows[0].entity).toBe("appointment");
    expect(rows[0].entity_id).toBe(created.id);
    expect(rows[0].created_at).toBeTruthy();
  });

  it("appointment.status_changed records from → to", async () => {
    const id = await confirmedAppointment();
    const rows = trail().filter((r) => r.action === "appointment.status_changed");
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe("u-operator");
    expect(rows[0].entity_id).toBe(id);
    expect(JSON.parse(rows[0].detail_json)).toMatchObject({
      from: "requested",
      to: "confirmed",
    });
  });

  it("scan.verified for an auto-accept scan", async () => {
    const id = await confirmedAppointment();
    allowAs(mocks, OPERATOR);
    const body = await (
      await postScans(
        postJson("/api/gate/scans", {
          appointmentId: id,
          plateRead: "AUD-1",
          containerRead: "TCLU4829103",
          confidence: 92,
        })
      )
    ).json();

    const rows = trail().filter((r) => r.action === "scan.verified");
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe("u-operator");
    expect(rows[0].entity).toBe("gate_verification_event");
    expect(rows[0].entity_id).toBe(body.verification.id);
    expect(JSON.parse(rows[0].detail_json)).toMatchObject({
      outcome: "auto-accept",
      autoAccepted: true,
    });
  });

  it("scan.verified + review.decided for a human-review item", async () => {
    const id = await confirmedAppointment();
    allowAs(mocks, OPERATOR);
    const scanned = await (
      await postScans(
        postJson("/api/gate/scans", {
          appointmentId: id,
          plateRead: "AUD-1",
          containerRead: "TCLU4829103",
          confidence: 20,
        })
      )
    ).json();

    allowAs(mocks, SUPERVISOR);
    await decideReview(
      postJson(`/api/gate/reviews/${scanned.reviewItemId}/decide`, {
        decision: "rejected",
      }),
      { params: Promise.resolve({ id: scanned.reviewItemId }) }
    );

    const scans = trail().filter((r) => r.action === "scan.verified");
    expect(scans).toHaveLength(1);
    expect(JSON.parse(scans[0].detail_json)).toMatchObject({
      outcome: "human-review",
    });

    const decisions = trail().filter((r) => r.action === "review.decided");
    expect(decisions).toHaveLength(1);
    expect(decisions[0].actor_id).toBe("u-supervisor");
    expect(decisions[0].entity).toBe("review_item");
    expect(decisions[0].entity_id).toBe(scanned.reviewItemId);
    expect(JSON.parse(decisions[0].detail_json)).toMatchObject({
      decision: "rejected",
    });
  });

  it("planning.run_created for a berth plan run", async () => {
    allowAs(mocks, PLANNER);
    const created = await (
      await postPlanRuns(postJson("/api/planning/runs", PLAN_BODY))
    ).json();

    const rows = trail().filter((r) => r.action === "planning.run_created");
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe("u-planner");
    expect(rows[0].entity).toBe("berth_plan");
    expect(rows[0].entity_id).toBe(created.id);
  });

  it("simulation.run_created for a simulation run", async () => {
    allowAs(mocks, PLANNER);
    const created = await (
      await postSimRuns(
        postJson("/api/simulate/runs", {
          scenarioName: "audit sim",
          scenarioId: "crisis",
          seed: 42,
          replications: 10,
        })
      )
    ).json();

    const rows = trail().filter((r) => r.action === "simulation.run_created");
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe("u-planner");
    expect(rows[0].entity).toBe("simulation");
    expect(rows[0].entity_id).toBe(created.id);
  });

  it("rejected mutations write NO audit event", async () => {
    const before = auditCount();
    // Illegal transition → 400, no audit.
    const id = await confirmedAppointment();
    const afterSetup = auditCount();
    allowAs(mocks, OPERATOR);
    const bad = await patchStatus(
      new NextRequest(`http://localhost/api/appointments/${id}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "requested" }), // illegal: confirmed → requested
      }),
      { params: Promise.resolve({ id }) }
    );
    expect(bad.status).toBe(400);
    expect(auditCount()).toBe(afterSetup);
    expect(auditCount()).toBeGreaterThan(before);
  });
});

describe("append-only: the trail can only grow", () => {
  it("no route handler UPDATEs or DELETEs audit_events (static guard)", () => {
    // Walk every route.ts under src/app/api and fail if one mutates the
    // audit table. The append-only property is by-convention at the DB
    // layer and enforced HERE at the HTTP layer.
    const apiDir = join(process.cwd(), "src", "app", "api");
    const offenders: string[] = [];
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.name === "route.ts") {
          const src = readFileSync(full, "utf8");
          if (/\b(UPDATE|DELETE\s+FROM)\s+audit_events\b/i.test(src)) {
            offenders.push(full);
          }
        }
      }
    };
    visit(apiDir);
    expect(offenders, `route handlers must never mutate audit_events`).toEqual([]);
  });

  it("audit row count is monotonically non-decreasing across mutations", async () => {
    expect(auditCount()).toBe(0);
    await confirmedAppointment();
    const n1 = auditCount();
    expect(n1).toBeGreaterThan(0);
    allowAs(mocks, PLANNER);
    await postPlanRuns(postJson("/api/planning/runs", PLAN_BODY));
    expect(auditCount()).toBeGreaterThan(n1);
  });

  it("every audit row has a unique id and a parseable detail object", async () => {
    await confirmedAppointment();
    const rows = trail();
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.size).toBe(rows.length);
    for (const r of rows) {
      expect(() => JSON.parse(r.detail_json)).not.toThrow();
      expect(r.actor_id).toBeTruthy();
      expect(r.action).toBeTruthy();
      expect(r.entity).toBeTruthy();
      expect(r.entity_id).toBeTruthy();
    }
  });
});
