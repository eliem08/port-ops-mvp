// Route tests for GET /api/dashboard (+ the /api/health liveness probe).
// Mocked-auth style: counts are verified live against a fresh in-memory DB
// populated through the real API routes.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  resetHarness,
  allowAs,
  denyWith,
  postJson,
  getReq,
  VIEWER,
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

import { GET as getDashboard } from "./route";
import { GET as getHealth } from "@/app/api/health/route";
import { POST as postAppointments } from "@/app/api/appointments/route";
import { POST as postPlanRuns } from "@/app/api/planning/runs/route";
import { POST as postSimRuns } from "@/app/api/simulate/runs/route";

beforeEach(() => {
  resetHarness(mocks);
});

const PLAN_BODY = {
  scenarioName: "dashboard plan",
  vessels: [
    {
      name: "SYN D1",
      lengthM: 200,
      draftM: 10,
      eta: "2026-10-20T06:00:00Z",
      etd: "2026-10-20T14:00:00Z",
      grainCapable: false,
    },
  ],
  berths: [{ name: "SYN DQ1", lengthM: 300, maxDraftM: 14, grainCapable: false }],
  solver: "greedy",
  seed: 42,
};

const SIM_BODY = {
  scenarioName: "dashboard sim",
  scenarioId: "crisis",
  seed: 42,
  replications: 10,
};

async function seedActivity(): Promise<void> {
  allowAs(mocks, OPERATOR);
  await postAppointments(
    postJson("/api/appointments", {
      truckPlate: "DASH-1",
      scheduledAt: "2026-10-20T10:00:00Z",
    })
  );
  allowAs(mocks, PLANNER);
  await postPlanRuns(postJson("/api/planning/runs", PLAN_BODY));
  await postSimRuns(postJson("/api/simulate/runs", SIM_BODY));
}

describe("GET /api/dashboard", () => {
  it("401 when unauthenticated", async () => {
    denyWith(mocks, 401, "unauthenticated");
    const res = await getDashboard(getReq("/api/dashboard"));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthenticated");
  });

  it("200 for operations_viewer with every metric bucket present", async () => {
    allowAs(mocks, VIEWER);
    const res = await getDashboard(getReq("/api/dashboard"));
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const key of [
      "appointmentsByStatus",
      "verificationsByOutcome",
      "pendingReviews",
      "totalAppointments",
      "totalVerifications",
      "plansBySolver",
      "totalPlans",
      "provenOptimalPlans",
      "simulationsByScenario",
      "totalSimulations",
      "recentAudit",
      "generatedAt",
    ]) {
      expect(body).toHaveProperty(key);
    }
    // Status buckets are zero-initialized even with an empty DB.
    expect(body.appointmentsByStatus).toMatchObject({
      requested: 0,
      confirmed: 0,
      "checked-in": 0,
      completed: 0,
      cancelled: 0,
      "no-show": 0,
    });
    expect(body.verificationsByOutcome).toMatchObject({
      "auto-accept": 0,
      "human-review": 0,
      "scan-failed": 0,
    });
  });

  it("counts reflect real mutations — no hardcoded numbers", async () => {
    await seedActivity();
    allowAs(mocks, VIEWER);
    const body = await (await getDashboard(getReq("/api/dashboard"))).json();

    expect(body.totalAppointments).toBe(1);
    expect(body.appointmentsByStatus.requested).toBe(1);
    expect(body.totalPlans).toBe(1);
    expect(body.plansBySolver.greedy).toBe(1);
    expect(body.totalSimulations).toBe(1);
    expect(body.simulationsByScenario["dashboard sim"]).toBe(1);

    // A second appointment moves the counters again.
    allowAs(mocks, OPERATOR);
    await postAppointments(
      postJson("/api/appointments", {
        truckPlate: "DASH-2",
        scheduledAt: "2026-10-20T11:00:00Z",
      })
    );
    allowAs(mocks, VIEWER);
    const again = await (await getDashboard(getReq("/api/dashboard"))).json();
    expect(again.totalAppointments).toBe(2);
    expect(again.appointmentsByStatus.requested).toBe(2);
  });

  it("recentAudit surfaces the latest audit entries", async () => {
    await seedActivity();
    allowAs(mocks, VIEWER);
    const body = await (await getDashboard(getReq("/api/dashboard"))).json();
    expect(Array.isArray(body.recentAudit)).toBe(true);
    expect(body.recentAudit.length).toBeLessThanOrEqual(10);
    for (const entry of body.recentAudit) {
      for (const key of ["id", "actorId", "action", "entity", "entityId", "createdAt"]) {
        expect(entry).toHaveProperty(key);
      }
    }
  });
});

describe("GET /api/health", () => {
  it("200 liveness with service identity — no auth required", async () => {
    const res = await getHealth();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("port-ops-mvp");
    expect(typeof body.version).toBe("string");
  });
});
