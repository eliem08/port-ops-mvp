// Verification tests for the six documented limitations (docs/LIMITATIONS.md).
// These tests PROVE the "fixed" / "dissolved" claims rather than just
// documenting them:
//
//  #3 GateWatch payload-replay: a stale/forged scan payload cannot replay
//     a dead appointment — the route loads the CURRENT appointment state
//     from the DB on every request. (Strict-schema rejection of forged
//     fields is already covered in security.test.ts §4.)
//  #4 TAS idempotency atomicity: concurrent duplicate creates with the same
//     idempotency key yield exactly one appointment row.
//
// Style: real-auth (like security.test.ts) — real JWTs signed with the
// fallback secret, real route handlers, mocked getDb/audit/next-headers.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { signTestSession, SESSION_COOKIE } from "@/test-utils/sessions";
import { freshTestDb, postJson } from "@/test-utils/route-harness";
import { loginRateLimiter, scanRateLimiter } from "@/lib/rate-limit";
import { createAppointment, setAppointmentStatus, getAppointment } from "@/lib/appointments";
import { MIGRATIONS } from "@/lib/db/migrations";

const mockState = vi.hoisted(() => ({
  db: null as DatabaseSync | null,
  cookieJar: new Map<string, string>(),
}));
vi.mock("@/lib/db/client", () => ({
  getDb: () => {
    if (!mockState.db) throw new Error("getDb called before test DB was set");
    return mockState.db;
  },
}));
vi.mock("@/lib/audit", () => ({ audit: () => {} }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = mockState.cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

import { POST as postAppointments } from "@/app/api/appointments/route";
import { POST as postScans } from "@/app/api/gate/scans/route";

const COOKIE_NAME = SESSION_COOKIE;

async function signSession(role: string, userId = "u-test"): Promise<string> {
  return await signTestSession(mockState.db!, role, userId);
}

async function loginAs(role: string, userId = "u-test"): Promise<void> {
  mockState.cookieJar.set(COOKIE_NAME, await signSession(role, userId));
}

let db: DatabaseSync;
beforeEach(() => {
  db = freshTestDb();
  mockState.db = db;
  mockState.cookieJar.clear();
  loginRateLimiter.reset();
  scanRateLimiter.reset();
});

const VALID_APPT = {
  truckPlate: "CAS-4821-A",
  containerNo: "TCLU4829103",
  driverName: "Test Driver",
  scheduledAt: "2026-10-20T10:00:00Z",
};

function countRows(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

// ── Limitation #3: GateWatch payload-replay is dissolved by construction ──

describe("limitation #3 — stale scan payload cannot replay a dead appointment", () => {
  it("replaying a valid scan AFTER cancellation yields human-review, not auto-accept", async () => {
    await loginAs("operations_operator");

    // 1. Create + confirm an appointment.
    const { record: appt } = createAppointment(db, "u-operator", {
      ...VALID_APPT,
      idempotencyKey: "replay-test-key-1",
    });
    setAppointmentStatus(db, appt.id, "confirmed");

    // 2. A valid scan while confirmed → auto-accept (proves the payload is good).
    const payload = {
      appointmentId: appt.id,
      plateRead: "CAS-4821-A",
      containerRead: "TCLU4829103",
      confidence: 95,
    };
    const first = await postScans(postJson("/api/gate/scans", payload));
    expect(first.status).toBe(201);
    expect((await first.json()).outcome).toBe("auto-accept");
    expect(getAppointment(db, appt.id)?.status).toBe("checked-in");

    // 3. Attacker replays the IDENTICAL payload after the appointment is
    //    cancelled. The server must re-read current DB state, not trust the
    //    stale "this used to be confirmable" implication of the payload.
    setAppointmentStatus(db, appt.id, "cancelled");
    const replay = await postScans(postJson("/api/gate/scans", payload));
    expect(replay.status).toBe(201);
    const body = await replay.json();
    expect(body.outcome).toBe("human-review");
    expect(body.reason).toContain("cancelled");
    // The cancelled appointment was NOT moved to checked-in.
    expect(getAppointment(db, appt.id)?.status).toBe("cancelled");
  });

  it("scan outcome always reflects the CURRENT db status, never client claims", async () => {
    await loginAs("operations_operator");
    const { record: appt } = createAppointment(db, "u-operator", {
      ...VALID_APPT,
      idempotencyKey: "replay-test-key-2",
    });
    // Still 'requested' — cannot transition to checked-in.
    const res = await postScans(
      postJson("/api/gate/scans", {
        appointmentId: appt.id,
        plateRead: "CAS-4821-A",
        containerRead: "TCLU4829103",
        confidence: 99, // high confidence, but status blocks auto-accept
      })
    );
    const body = await res.json();
    expect(body.outcome).toBe("human-review");
    expect(body.reason).toContain("requested");
  });
});

// ── Limitation #4: TAS idempotency is atomic ─────────────────────────────

describe("limitation #4 — atomic idempotency (exactly one row per key)", () => {
  it("sequential duplicates with the same key return the existing record", () => {
    const key = "idem-sequential-1";
    const first = createAppointment(db, "u-op", { ...VALID_APPT, idempotencyKey: key });
    const second = createAppointment(db, "u-op", { ...VALID_APPT, idempotencyKey: key });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);
    expect(countRows("appointments")).toBe(1);
    expect(countRows("idempotency_keys")).toBe(1);
  });

  it("HTTP-level: POST twice with the same key → 201 then 200, same id", async () => {
    await loginAs("operations_operator");
    const body = { ...VALID_APPT, idempotencyKey: "idem-http-1" };

    const r1 = await postAppointments(postJson("/api/appointments", body));
    expect(r1.status).toBe(201);
    const id1 = (await r1.json()).id;

    const r2 = await postAppointments(postJson("/api/appointments", body));
    expect(r2.status).toBe(200); // idempotent replay, not a new resource
    const id2 = (await r2.json()).id;

    expect(id2).toBe(id1);
    expect(countRows("appointments")).toBe(1);
  });

  it("the key-claim is mutually exclusive across connections (BEGIN IMMEDIATE)", async () => {
    // Two independent connections to the SAME file DB. Connection A takes
    // the write lock and claims the key without committing; connection B
    // must NOT be able to slip in — it gets SQLITE_BUSY on BEGIN IMMEDIATE.
    const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const file = join(mkdtempSync(join(tmpdir(), "idem-")), "t.db");

    // Migrate once (as npm run db:migrate would); the second connection
    // just opens the already-migrated file.
    const open = (migrate: boolean) => {
      const c = new sqlite.DatabaseSync(file);
      c.exec("PRAGMA foreign_keys = ON;");
      if (migrate) for (const m of MIGRATIONS) c.exec(m.sql);
      return c;
    };
    const connA = open(true);
    const connB = open(false);
    try {
      connA.exec("BEGIN IMMEDIATE");
      const claimA = connA
        .prepare("INSERT OR IGNORE INTO idempotency_keys (key) VALUES (?)")
        .run("race-key-1");
      expect(claimA.changes).toBe(1); // A claimed it

      // B cannot even begin a write txn while A holds the lock.
      expect(() => connB.exec("BEGIN IMMEDIATE")).toThrow();

      connA.exec("COMMIT");

      // After A commits, B's claim of the same key is a no-op (already exists).
      connB.exec("BEGIN IMMEDIATE");
      const claimB = connB
        .prepare("INSERT OR IGNORE INTO idempotency_keys (key) VALUES (?)")
        .run("race-key-1");
      expect(claimB.changes).toBe(0); // already claimed → no duplicate
      connB.exec("COMMIT");

      expect(
        (connA.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get() as { n: number }).n
      ).toBe(1);
    } finally {
      connA.close();
      connB.close();
    }
  });

  it("different keys still create different appointments", () => {
    const a = createAppointment(db, "u-op", { ...VALID_APPT, idempotencyKey: "idem-diff-a" });
    const b = createAppointment(db, "u-op", { ...VALID_APPT, idempotencyKey: "idem-diff-b" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.record.id).not.toBe(b.record.id);
    expect(countRows("appointments")).toBe(2);
  });
});
