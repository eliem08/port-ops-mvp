// API route tests for /api/simulate/* — authz, validation, idempotency,
// compare. Auth, DB and audit are mocked; the route handlers, zod
// contracts and the simulation domain run for real.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "@/lib/db/migrations";

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

import { POST as postRuns, GET as getRuns } from "./runs/route";
import { GET as getRunById } from "./runs/[id]/route";
import { GET as getCompare } from "./compare/route";

function freshDb(): DatabaseSync {
  const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const m of MIGRATIONS) db.exec(m.sql);
  return db;
}

const PLANNER = { userId: "u-planner", label: "Planner", role: "planner" };
const VIEWER = { userId: "u-viewer", label: "Viewer", role: "operations_viewer" };

function rejectWith(status: number, code: string) {
  mocks.requireApiRole.mockRejectedValue(
    new Response(JSON.stringify({ error: { code, message: code } }), { status })
  );
}

function postJson(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getReq(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method: "GET" });
}

const VALID_BODY = {
  scenarioName: "Crisis baseline",
  scenarioId: "crisis",
  seed: 42,
  replications: 10,
};

let db: DatabaseSync;

beforeEach(() => {
  db = freshDb();
  mocks.getDb.mockReturnValue(db);
  mocks.requireApiRole.mockReset();
  mocks.audit.mockClear();
});

describe("POST /api/simulate/runs", () => {
  it("401 when unauthenticated", async () => {
    rejectWith(401, "unauthenticated");
    const res = await postRuns(postJson("/api/simulate/runs", VALID_BODY));
    expect(res.status).toBe(401);
  });

  it("403 when the role is operations_viewer", async () => {
    rejectWith(403, "forbidden");
    const res = await postRuns(postJson("/api/simulate/runs", VALID_BODY));
    expect(res.status).toBe(403);
  });

  it("201 on first run, 200 + created=false on idempotent replay", async () => {
    mocks.requireApiRole.mockResolvedValue(PLANNER);
    const first = await postRuns(postJson("/api/simulate/runs", VALID_BODY));
    expect(first.status).toBe(201);
    const firstJson = await first.json();
    expect(firstJson.scenarioId).toBe("crisis");
    expect(firstJson.created).toBe(true);
    expect(firstJson.calibrated).toBe(false);

    const second = await postRuns(postJson("/api/simulate/runs", VALID_BODY));
    expect(second.status).toBe(200);
    const secondJson = await second.json();
    expect(secondJson.created).toBe(false);
    expect(secondJson.id).toBe(firstJson.id);

    expect(mocks.audit).toHaveBeenCalledWith(
      "u-planner",
      "simulation.run_created",
      "simulation",
      firstJson.id,
      expect.objectContaining({ idempotentReplay: false })
    );
  });

  it("400 on unknown scenarioId", async () => {
    mocks.requireApiRole.mockResolvedValue(PLANNER);
    const res = await postRuns(
      postJson("/api/simulate/runs", { ...VALID_BODY, scenarioId: "nope" })
    );
    expect(res.status).toBe(400);
  });

  it("400 on replications out of range", async () => {
    mocks.requireApiRole.mockResolvedValue(PLANNER);
    const res = await postRuns(
      postJson("/api/simulate/runs", { ...VALID_BODY, replications: 5 })
    );
    expect(res.status).toBe(400);
  });

  it("400 on a bad seed type", async () => {
    mocks.requireApiRole.mockResolvedValue(PLANNER);
    const res = await postRuns(
      postJson("/api/simulate/runs", { ...VALID_BODY, seed: "abc" })
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/simulate/runs", () => {
  it("401 when unauthenticated", async () => {
    rejectWith(401, "unauthenticated");
    const res = await getRuns(getReq("/api/simulate/runs"));
    expect(res.status).toBe(401);
  });

  it("200 with the run list for operations_viewer", async () => {
    mocks.requireApiRole.mockResolvedValue(PLANNER);
    await postRuns(postJson("/api/simulate/runs", VALID_BODY));
    mocks.requireApiRole.mockResolvedValue(VIEWER);
    const res = await getRuns(getReq("/api/simulate/runs"));
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list).toHaveLength(1);
    expect(list[0].scenarioId).toBe("crisis");
  });
});

describe("GET /api/simulate/runs/[id]", () => {
  it("404 for an unknown id", async () => {
    mocks.requireApiRole.mockResolvedValue(VIEWER);
    const res = await getRunById(getReq("/api/simulate/runs/x"), {
      params: Promise.resolve({ id: "does-not-exist" }),
    });
    expect(res.status).toBe(404);
  });

  it("200 with KPIs and the uncalibrated notice for a known id", async () => {
    mocks.requireApiRole.mockResolvedValue(PLANNER);
    const created = await postRuns(postJson("/api/simulate/runs", VALID_BODY));
    const { id } = await created.json();

    mocks.requireApiRole.mockResolvedValue(VIEWER);
    const res = await getRunById(getReq(`/api/simulate/runs/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
    const run = await res.json();
    expect(run.kpis.length).toBeGreaterThan(0);
    expect(
      run.kpis.every((k: { provenance: string }) => k.provenance === "simulated")
    ).toBe(true);
    expect(run.assumptions.join("\n")).toContain(
      "Model uncalibrated against real operational data"
    );
  });
});

describe("GET /api/simulate/compare", () => {
  async function twoRuns(): Promise<[string, string]> {
    mocks.requireApiRole.mockResolvedValue(PLANNER);
    const a = await (
      await postRuns(postJson("/api/simulate/runs", VALID_BODY))
    ).json();
    const b = await (
      await postRuns(
        postJson("/api/simulate/runs", {
          ...VALID_BODY,
          scenarioId: "tas",
          scenarioName: "TAS intervention",
        })
      )
    ).json();
    return [a.id, b.id];
  }

  it("400 when a/b are missing or not UUIDs", async () => {
    mocks.requireApiRole.mockResolvedValue(VIEWER);
    expect(
      (await getCompare(getReq("/api/simulate/compare"))).status
    ).toBe(400);
    expect(
      (await getCompare(getReq("/api/simulate/compare?a=abc&b=def"))).status
    ).toBe(400);
  });

  it("404 for unknown run ids", async () => {
    mocks.requireApiRole.mockResolvedValue(VIEWER);
    const fake = "00000000-0000-4000-8000-000000000000";
    const res = await getCompare(
      getReq(`/api/simulate/compare?a=${fake}&b=${fake}`)
    );
    expect(res.status).toBe(404);
  });

  it("200 with both DTOs and a correct delta table", async () => {
    const [idA, idB] = await twoRuns();
    mocks.requireApiRole.mockResolvedValue(VIEWER);
    const res = await getCompare(
      getReq(`/api/simulate/compare?a=${idA}&b=${idB}`)
    );
    expect(res.status).toBe(200);
    const cmp = await res.json();
    expect(cmp.a.id).toBe(idA);
    expect(cmp.b.id).toBe(idB);
    expect(cmp.deltas.length).toBe(cmp.a.kpis.length);
    const wait = cmp.deltas.find(
      (d: { key: string }) => d.key === "meanWaitMin"
    );
    const ka = cmp.a.kpis.find((k: { key: string }) => k.key === "meanWaitMin");
    const kb = cmp.b.kpis.find((k: { key: string }) => k.key === "meanWaitMin");
    expect(wait.delta).toBeCloseTo(kb.value - ka.value, 10);
  });
});
