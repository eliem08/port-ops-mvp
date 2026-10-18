// Route tests for /api/appointments*, following the simulate-routes.test.ts
// pattern: requireApiRole / getDb / audit are mocked; the handlers, zod
// contracts and the appointment domain run for real against a fresh
// in-memory SQLite DB per test.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  resetHarness,
  allowAs,
  denyWith,
  postJson,
  patchJson,
  getReq,
  VIEWER,
  OPERATOR,
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

import { POST as postAppointments, GET as getAppointments } from "./route";
import { GET as getAppointmentById } from "./[id]/route";
import { PATCH as patchStatus } from "./[id]/status/route";

let db: DatabaseSync;
beforeEach(() => {
  db = resetHarness(mocks);
});

const VALID_APPT = {
  truckPlate: "CAS-4821-A",
  containerNo: "TCLU4829103",
  driverName: "Test Driver",
  scheduledAt: "2026-10-20T10:00:00Z",
};

async function createAs(operator = OPERATOR, body: unknown = VALID_APPT) {
  allowAs(mocks, operator);
  return await postAppointments(postJson("/api/appointments", body));
}

function countAppointments(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM appointments").get() as { n: number }).n;
}

// ── POST /api/appointments ───────────────────────────────────────────────

describe("POST /api/appointments", () => {
  it("401 when unauthenticated", async () => {
    denyWith(mocks, 401, "unauthenticated");
    const res = await postAppointments(postJson("/api/appointments", VALID_APPT));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthenticated");
  });

  it("403 when the role is operations_viewer (operator required)", async () => {
    denyWith(mocks, 403, "forbidden");
    const res = await postAppointments(postJson("/api/appointments", VALID_APPT));
    expect(res.status).toBe(403);
    expect(countAppointments()).toBe(0);
  });

  it("201 with the appointment record; audits appointment.created", async () => {
    const res = await createAs();
    expect(res.status).toBe(201);
    const appt = await res.json();
    expect(appt.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(appt.truckPlate).toBe("CAS-4821-A");
    expect(appt.status).toBe("requested");
    expect(appt.createdBy).toBe("u-operator");
    expect(mocks.audit).toHaveBeenCalledWith(
      "u-operator",
      "appointment.created",
      "appointment",
      appt.id,
      expect.objectContaining({ idempotentReplay: false })
    );
  });

  it("400 on missing truckPlate / bad scheduledAt / extra field / bad key", async () => {
    allowAs(mocks, OPERATOR);
    const bad = [
      { ...VALID_APPT, truckPlate: undefined },
      { ...VALID_APPT, scheduledAt: "2026-10-20 10:00:00" }, // no Z suffix
      { ...VALID_APPT, surprise: "nope" }, // strict() rejects extras
      { ...VALID_APPT, containerNo: "WAYTOOLONG12345" }, // > 11 chars
      { ...VALID_APPT, idempotencyKey: "short" }, // min 8
    ];
    for (const body of bad) {
      const res = await postAppointments(postJson("/api/appointments", body));
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("validation_error");
    }
    expect(countAppointments()).toBe(0);
  });

  it("200 + same record on idempotent replay (same idempotencyKey)", async () => {
    const body = { ...VALID_APPT, idempotencyKey: "idem-appointment-01" };
    const first = await createAs(OPERATOR, body);
    expect(first.status).toBe(201);
    const created = await first.json();

    allowAs(mocks, OPERATOR);
    const second = await postAppointments(postJson("/api/appointments", body));
    expect(second.status).toBe(200);
    const replayed = await second.json();
    expect(replayed.id).toBe(created.id);
    expect(countAppointments()).toBe(1);
    expect(mocks.audit).toHaveBeenCalledWith(
      "u-operator",
      "appointment.created",
      "appointment",
      created.id,
      expect.objectContaining({ idempotentReplay: true })
    );
  });
});

// ── GET /api/appointments ────────────────────────────────────────────────

describe("GET /api/appointments", () => {
  it("401 when unauthenticated", async () => {
    denyWith(mocks, 401, "unauthenticated");
    const res = await getAppointments(getReq("/api/appointments"));
    expect(res.status).toBe(401);
  });

  it("200 list for operations_viewer, newest first", async () => {
    await createAs(OPERATOR, { ...VALID_APPT, truckPlate: "PLATE-ONE" });
    await createAs(OPERATOR, { ...VALID_APPT, truckPlate: "PLATE-TWO" });

    allowAs(mocks, VIEWER);
    const res = await getAppointments(getReq("/api/appointments"));
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list).toHaveLength(2);
    expect(new Date(list[0].createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(list[1].createdAt).getTime()
    );
  });

  it("?status= filters; invalid filter → 400", async () => {
    await createAs();

    allowAs(mocks, VIEWER);
    const filtered = await getAppointments(
      getReq("/api/appointments?status=requested")
    );
    expect(filtered.status).toBe(200);
    expect(await filtered.json()).toHaveLength(1);

    const empty = await getAppointments(
      getReq("/api/appointments?status=completed")
    );
    expect(await empty.json()).toHaveLength(0);

    const bad = await getAppointments(getReq("/api/appointments?status=bogus"));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("invalid_status_filter");
  });
});

// ── GET /api/appointments/[id] ───────────────────────────────────────────

describe("GET /api/appointments/[id]", () => {
  it("401 when unauthenticated", async () => {
    denyWith(mocks, 401, "unauthenticated");
    const res = await getAppointmentById(getReq("/api/appointments/x"), {
      params: Promise.resolve({ id: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("200 with appointment + verificationHistory for a viewer", async () => {
    const { id } = await (await createAs()).json();

    allowAs(mocks, VIEWER);
    const res = await getAppointmentById(
      getReq(`/api/appointments/${id}`),
      { params: Promise.resolve({ id }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.appointment.id).toBe(id);
    expect(body.verificationHistory).toEqual([]);
  });

  it("404 for an unknown id", async () => {
    allowAs(mocks, VIEWER);
    const res = await getAppointmentById(
      getReq("/api/appointments/does-not-exist"),
      { params: Promise.resolve({ id: "does-not-exist" }) }
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });
});

// ── PATCH /api/appointments/[id]/status ──────────────────────────────────

describe("PATCH /api/appointments/[id]/status", () => {
  async function makeRequested(): Promise<string> {
    return (await (await createAs()).json()).id as string;
  }

  function patchStatusAs(session: typeof OPERATOR, id: string, to: string) {
    allowAs(mocks, session);
    return patchStatus(patchJson(`/api/appointments/${id}/status`, { to }), {
      params: Promise.resolve({ id }),
    });
  }

  it("401 when unauthenticated", async () => {
    denyWith(mocks, 401, "unauthenticated");
    const res = await patchStatus(
      patchJson("/api/appointments/x/status", { to: "confirmed" }),
      { params: Promise.resolve({ id: "x" }) }
    );
    expect(res.status).toBe(401);
  });

  it("403 when the role is operations_viewer (operator required)", async () => {
    const id = await makeRequested();
    denyWith(mocks, 403, "forbidden");
    const res = await patchStatus(
      patchJson(`/api/appointments/${id}/status`, { to: "confirmed" }),
      { params: Promise.resolve({ id }) }
    );
    expect(res.status).toBe(403);
  });

  it("200 on the legal requested → confirmed transition; audits the change", async () => {
    const id = await makeRequested();
    const res = await patchStatusAs(OPERATOR, id, "confirmed");
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("confirmed");
    expect(mocks.audit).toHaveBeenCalledWith(
      "u-operator",
      "appointment.status_changed",
      "appointment",
      id,
      { from: "requested", to: "confirmed" }
    );
  });

  it("400 illegal_transition for requested → completed (skips the machine)", async () => {
    const id = await makeRequested();
    const res = await patchStatusAs(OPERATOR, id, "completed");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("illegal_transition");
    // status unchanged
    const row = db
      .prepare("SELECT status FROM appointments WHERE id = ?")
      .get(id) as { status: string };
    expect(row.status).toBe("requested");
  });

  it("400 validation_error for a non-enum target / extra field", async () => {
    const id = await makeRequested();
    allowAs(mocks, OPERATOR);
    for (const body of [{ to: "flying" }, { to: "confirmed", extra: 1 }, {}]) {
      const res = await patchStatus(
        patchJson(`/api/appointments/${id}/status`, body),
        { params: Promise.resolve({ id }) }
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("validation_error");
    }
  });

  it("404 for an unknown appointment id", async () => {
    allowAs(mocks, OPERATOR);
    const res = await patchStatus(
      patchJson("/api/appointments/nope/status", { to: "confirmed" }),
      { params: Promise.resolve({ id: "nope" }) }
    );
    expect(res.status).toBe(404);
  });

  it("terminal statuses reject every transition", async () => {
    const id = await makeRequested();
    // Drive to 'cancelled' (requested → cancelled is legal).
    expect((await patchStatusAs(OPERATOR, id, "cancelled")).status).toBe(200);
    // Everything out of a terminal state is illegal.
    for (const to of ["requested", "confirmed", "checked-in", "completed", "no-show"]) {
      const res = await patchStatusAs(OPERATOR, id, to);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("illegal_transition");
    }
  });
});
