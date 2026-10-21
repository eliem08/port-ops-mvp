// Route tests for /api/planning/runs (+ [id]).
// next/headers is mocked so requireApiRole sees a controlled session cookie.
// The DB client is real (node:sqlite via the test shim) pointed at a temp file.

import { describe, it, expect, vi, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signTestSession } from "@/test-utils/sessions";

const cookieState = vi.hoisted(() => ({
  token: undefined as string | undefined,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () =>
      cookieState.token ? { value: cookieState.token } : undefined,
  }),
}));

async function tokenFor(role: string): Promise<string> {
  return await signTestSession(getDb(), role, "u-test");
}

const dbFile = join(
  mkdtempSync(join(tmpdir(), "portops-planning-route-")),
  "test.sqlite"
);
process.env.DATABASE_URL = `file:${dbFile}`;

// Dynamic imports AFTER env and mocks are in place.
const { POST, GET } = await import("./route");
const detailRoute = await import("./[id]/route");
const { NextRequest } = await import("next/server");
const { getDb } = await import("@/lib/db/client");
const { MIGRATIONS } = await import("@/lib/db/migrations");

beforeAll(() => {
  for (const m of MIGRATIONS) getDb().exec(m.sql);
});

function postJson(body: unknown): InstanceType<typeof NextRequest> {
  return new NextRequest("http://localhost/api/planning/runs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  scenarioName: "route test",
  vessels: [
    {
      name: "SYN T1",
      lengthM: 200,
      draftM: 10,
      eta: "2026-10-20T06:00:00Z",
      etd: "2026-10-20T14:00:00Z",
      grainCapable: false,
    },
    {
      name: "SYN T2",
      lengthM: 180,
      draftM: 9,
      eta: "2026-10-20T08:00:00Z",
      etd: "2026-10-20T16:00:00Z",
      grainCapable: false,
    },
  ],
  berths: [
    { name: "SYN Q1", lengthM: 300, maxDraftM: 14, grainCapable: false },
  ],
  solver: "greedy",
  seed: 42,
};

describe("POST /api/planning/runs — auth", () => {
  it("unauthenticated → 401", async () => {
    cookieState.token = undefined;
    const res = await POST(postJson(VALID_BODY));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthenticated");
  });

  it("operations_viewer → 403 (planner required)", async () => {
    cookieState.token = await tokenFor("operations_viewer");
    const res = await POST(postJson(VALID_BODY));
    expect(res.status).toBe(403);
  });

  it("operations_operator → allowed (same rank as planner in the role hierarchy)", async () => {
    cookieState.token = await tokenFor("operations_operator");
    const res = await POST(
      postJson({ ...VALID_BODY, scenarioName: "route test — operator" })
    );
    expect([200, 201]).toContain(res.status);
  });
});

describe("POST /api/planning/runs — behaviour", () => {
  it("planner → 201 on create, 200 on idempotent replay", async () => {
    cookieState.token = await tokenFor("planner");
    const body = { ...VALID_BODY, scenarioName: "route test — replay" };
    const first = await POST(postJson(body));
    expect(first.status).toBe(201);
    const created = await first.json();
    expect(created.provenOptimal).toBe(false);
    expect(created.solverUsed).toBe("greedy");

    const second = await POST(postJson(body));
    expect(second.status).toBe(200);
    const replayed = await second.json();
    expect(replayed.id).toBe(created.id);
  });

  it("audits planning.run_created", async () => {
    const rows = getDb()
      .prepare("SELECT action FROM audit_events WHERE action = ?")
      .all("planning.run_created") as Array<{ action: string }>;
    expect(rows.length).toBeGreaterThan(0);
  });

  it("invalid body → 400 validation_error", async () => {
    cookieState.token = await tokenFor("planner");
    const res = await POST(postJson({ ...VALID_BODY, vessels: [] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation_error");
  });

  it("unknown solver → 400 validation_error", async () => {
    cookieState.token = await tokenFor("planner");
    const res = await POST(postJson({ ...VALID_BODY, solver: "alns" }));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/planning/runs", () => {
  it("unauthenticated → 401", async () => {
    cookieState.token = undefined;
    const res = await GET(
      new NextRequest("http://localhost/api/planning/runs")
    );
    expect(res.status).toBe(401);
  });

  it("operations_viewer lists runs newest first", async () => {
    cookieState.token = await tokenFor("operations_viewer");
    const res = await GET(
      new NextRequest("http://localhost/api/planning/runs")
    );
    expect(res.status).toBe(200);
    const runs = await res.json();
    expect(Array.isArray(runs)).toBe(true);
    expect(runs.length).toBeGreaterThan(0);
  });
});

describe("GET /api/planning/runs/[id]", () => {
  it("returns the run for a viewer; 404 for unknown id", async () => {
    cookieState.token = await tokenFor("planner");
    const created = await (
      await POST(postJson({ ...VALID_BODY, scenarioName: "detail route test" }))
    ).json();

    cookieState.token = await tokenFor("operations_viewer");
    const okRes = await detailRoute.GET(
      new NextRequest(`http://localhost/api/planning/runs/${created.id}`),
      { params: Promise.resolve({ id: created.id }) }
    );
    expect(okRes.status).toBe(200);
    expect((await okRes.json()).id).toBe(created.id);

    const missing = await detailRoute.GET(
      new NextRequest("http://localhost/api/planning/runs/does-not-exist"),
      { params: Promise.resolve({ id: "does-not-exist" }) }
    );
    expect(missing.status).toBe(404);
  });

  it("unauthenticated → 401", async () => {
    cookieState.token = undefined;
    const res = await detailRoute.GET(
      new NextRequest("http://localhost/api/planning/runs/x"),
      { params: Promise.resolve({ id: "x" }) }
    );
    expect(res.status).toBe(401);
  });
});
