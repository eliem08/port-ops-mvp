// Security regression tests for the Port Operations Intelligence Platform.
// Style: REAL auth (requireApiRole runs for real — only next/headers cookies
// are mocked, JWTs are genuinely signed/verified), mocked getDb (fresh
// in-memory DB per test) and mocked audit. This tests the actual guard,
// the real zod contracts, and the real route handlers end to end.
//
// NOTE on the mocks below: vi.hoisted factories must not call imported
// functions (that breaks module init order — found empirically), so the
// mock state is built inline with plain closures instead of the shared
// makeMocks() helper. Route-harness request builders are still reused.
//
// Covers:
//  - No token → 401 on protected routes
//  - Wrong role (viewer on an operator action) → 403
//  - Tampered JWT (wrong signature / mutated payload / expired / bad role) → 401
//  - Malicious inputs: SQLi strings, XSS payloads, oversized bodies, invalid JSON
//  - Rate limiter unit behavior + route-level enforcement (login, scans)
//  - GateWatch replay boundary: the route trusts only appointmentId; the
//    appointment record comes from the DB, client-supplied appointment
//    fields are rejected by the strict schema.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { signTestSession, SESSION_COOKIE } from "@/test-utils/sessions";
import { NextRequest } from "next/server";
import { freshTestDb, postJson } from "@/test-utils/route-harness";
import { MAX_BODY_BYTES } from "@/lib/route-helpers";
import {
  createRateLimiter,
  loginRateLimiter,
  scanRateLimiter,
} from "@/lib/rate-limit";
import { SubmitScanInput, CreateAppointmentInput } from "@/contracts";
import { createAppointment, setAppointmentStatus } from "@/lib/appointments";

// ── Mock state (inline hoisted closures — see note above) ───────────────
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

// Real route handlers + real auth, running against the mocked DB.
import { GET as getAppointments, POST as postAppointments } from "@/app/api/appointments/route";
import { POST as postScans } from "@/app/api/gate/scans/route";
import { POST as postLogin } from "@/app/api/auth/login/route";
import { POST as decideReview } from "@/app/api/gate/reviews/[id]/decide/route";

// ── JWT helpers ──────────────────────────────────────────────────────────
// auth.ts falls back to this secret in tests (vitest does not load .env).
const FALLBACK_SECRET = new TextEncoder().encode("dev-only-change-me-in-production");
const WRONG_SECRET = new TextEncoder().encode("attacker-controlled-secret");
const COOKIE_NAME = SESSION_COOKIE;

async function signSession(
  role: string,
  userId = "u-test",
  secret: Uint8Array = FALLBACK_SECRET,
  exp = "2h"
): Promise<string> {
  return await signTestSession(mockState.db!, role, userId, { secret, exp });
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

function seedAppointment(overrides: Partial<typeof VALID_APPT> = {}) {
  const { record } = createAppointment(db, "u-operator", {
    ...VALID_APPT,
    ...overrides,
  });
  return record;
}

function countRows(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

// ── 1. Auth guard: 401 / 403 ─────────────────────────────────────────────

describe("auth guard (real requireApiRole)", () => {
  it("401 with no token on a protected GET route", async () => {
    const res = await getAppointments(
      new NextRequest("http://localhost/api/appointments", { method: "GET" })
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthenticated");
  });

  it("401 with no token on a protected POST route", async () => {
    const res = await postAppointments(postJson("/api/appointments", VALID_APPT));
    expect(res.status).toBe(401);
  });

  it("403 when operations_viewer attempts an operator action", async () => {
    await loginAs("operations_viewer");
    const res = await postAppointments(postJson("/api/appointments", VALID_APPT));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden");
    // Nothing was written — the guard runs before any DB access.
    expect(countRows("appointments")).toBe(0);
  });

  it("403 when operations_viewer attempts a supervisor action", async () => {
    await loginAs("operations_viewer");
    const res = await decideReview(
      postJson("/api/gate/reviews/some-id/decide", { decision: "approved" }),
      { params: Promise.resolve({ id: "some-id" }) }
    );
    expect(res.status).toBe(403);
  });

  it("401 for a JWT with the wrong signature (tampered)", async () => {
    mockState.cookieJar.set(
      COOKIE_NAME,
      await signSession("administrator", "u-evil", WRONG_SECRET)
    );
    const res = await getAppointments(
      new NextRequest("http://localhost/api/appointments", { method: "GET" })
    );
    expect(res.status).toBe(401);
  });

  it("401 for a JWT with a mutated payload (signature no longer matches)", async () => {
    const valid = await signSession("operations_viewer");
    const [h, p, s] = valid.split(".");
    // Flip one character in the payload segment — signature must fail.
    const mutatedPayload = p.slice(0, 10) + (p[10] === "A" ? "B" : "A") + p.slice(11);
    mockState.cookieJar.set(COOKIE_NAME, `${h}.${mutatedPayload}.${s}`);
    const res = await getAppointments(
      new NextRequest("http://localhost/api/appointments", { method: "GET" })
    );
    expect(res.status).toBe(401);
  });

  it("401 for an expired JWT", async () => {
    mockState.cookieJar.set(
      COOKIE_NAME,
      await signSession("administrator", "u-test", FALLBACK_SECRET, "-1h")
    );
    const res = await getAppointments(
      new NextRequest("http://localhost/api/appointments", { method: "GET" })
    );
    expect(res.status).toBe(401);
  });

  it("401 for a JWT carrying an unknown role", async () => {
    mockState.cookieJar.set(COOKIE_NAME, await signSession("superadmin"));
    const res = await getAppointments(
      new NextRequest("http://localhost/api/appointments", { method: "GET" })
    );
    expect(res.status).toBe(401);
  });

  it("operator session passes the guard and creates (sanity)", async () => {
    await loginAs("operations_operator");
    const res = await postAppointments(postJson("/api/appointments", VALID_APPT));
    expect(res.status).toBe(201);
  });

  it("higher roles inherit: supervisor can perform operator actions", async () => {
    await loginAs("supervisor");
    const res = await postAppointments(postJson("/api/appointments", VALID_APPT));
    expect(res.status).toBe(201);
  });
});

// ── 2. Malicious inputs ──────────────────────────────────────────────────

describe("malicious input handling", () => {
  it("SQL injection string in truckPlate is stored verbatim, DB intact", async () => {
    await loginAs("operations_operator");
    const evil = "' OR '1'='1"; // 11 chars — passes the max(20) schema bound
    const res = await postAppointments(
      postJson("/api/appointments", { ...VALID_APPT, truckPlate: evil })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.truckPlate).toBe(evil); // stored as data, not executed
    // The table still exists and holds exactly one row — no injection.
    expect(countRows("appointments")).toBe(1);
    const stored = (
      db.prepare("SELECT truck_plate FROM appointments").get() as { truck_plate: string }
    ).truck_plate;
    expect(stored).toBe(evil);
  });

  it("SQL injection attempt in the status filter is rejected by the enum", async () => {
    await loginAs("operations_viewer");
    const res = await getAppointments(
      new NextRequest("http://localhost/api/appointments?status=' OR '1'='1", {
        method: "GET",
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_status_filter");
  });

  it("XSS payload in driverName is stored verbatim (never executed server-side)", async () => {
    await loginAs("operations_operator");
    const xss = "<script>alert(1)</script>";
    const res = await postAppointments(
      postJson("/api/appointments", { ...VALID_APPT, driverName: xss })
    );
    expect(res.status).toBe(201);
    expect((await res.json()).driverName).toBe(xss);
    // Rendering safety is React's default escaping; the repo has no
    // dangerouslySetInnerHTML in src (verified by grep during the audit).
  });

  it("oversized body (>1MB) is rejected with 413", async () => {
    await loginAs("operations_operator");
    const big = new NextRequest("http://localhost/api/appointments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(MAX_BODY_BYTES + 1),
    });
    const res = await postAppointments(big);
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("payload_too_large");
  });

  it("invalid JSON is rejected with 400, no stack trace", async () => {
    await loginAs("operations_operator");
    const bad = new NextRequest("http://localhost/api/appointments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });
    const res = await postAppointments(bad);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_json");
    expect(JSON.stringify(body)).not.toContain("SyntaxError");
  });

  it("oversized truckPlate is rejected by the contract", async () => {
    await loginAs("operations_operator");
    const res = await postAppointments(
      postJson("/api/appointments", { ...VALID_APPT, truckPlate: "A".repeat(21) })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("validation_error");
  });

  it("contract schemas are strict: unknown keys rejected", () => {
    expect(
      CreateAppointmentInput.safeParse({ ...VALID_APPT, isAdmin: true }).success
    ).toBe(false);
    expect(
      SubmitScanInput.safeParse({
        appointmentId: "123e4567-e89b-12d3-a456-426614174000",
        plateRead: "X",
        outcome: "auto-accept", // client must never set the outcome
      }).success
    ).toBe(false);
  });
});

// ── 3. Rate limiter ──────────────────────────────────────────────────────

describe("token-bucket rate limiter (unit)", () => {
  it("allows up to the limit, then denies with retryAfterSec", () => {
    const rl = createRateLimiter({ limit: 3, windowSec: 60 });
    const t = 1_000_000;
    expect(rl.check("k", t).allowed).toBe(true);
    expect(rl.check("k", t).allowed).toBe(true);
    const third = rl.check("k", t);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
    const denied = rl.check("k", t);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
  });

  it("refills over time", () => {
    const rl = createRateLimiter({ limit: 2, windowSec: 60 });
    const t = 1_000_000;
    rl.check("k", t);
    rl.check("k", t);
    expect(rl.check("k", t).allowed).toBe(false);
    // Half a window later: one token refilled.
    expect(rl.check("k", t + 30_000).allowed).toBe(true);
    expect(rl.check("k", t + 30_000).allowed).toBe(false);
  });

  it("isolates buckets per key", () => {
    const rl = createRateLimiter({ limit: 1, windowSec: 60 });
    const t = 1_000_000;
    expect(rl.check("a", t).allowed).toBe(true);
    expect(rl.check("a", t).allowed).toBe(false);
    expect(rl.check("b", t).allowed).toBe(true);
  });

  it("reset() clears a bucket", () => {
    const rl = createRateLimiter({ limit: 1, windowSec: 60 });
    const t = 1_000_000;
    rl.check("k", t);
    expect(rl.check("k", t).allowed).toBe(false);
    rl.reset("k");
    expect(rl.check("k", t).allowed).toBe(true);
  });
});

describe("rate limiting on routes", () => {
  it("POST /api/auth/login: 10 attempts allowed, 11th → 429 with Retry-After", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await postLogin(
        postJson("/api/auth/login", { email: "nobody@example.com", password: "wrong-password" })
      );
      expect(res.status).toBe(401); // unknown account, but not rate limited
    }
    const limited = await postLogin(
      postJson("/api/auth/login", { email: "nobody@example.com", password: "wrong-password" })
    );
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe("rate_limited");
    expect(limited.headers.get("Retry-After")).toBeTruthy();
  });

  it("POST /api/gate/scans: 60/min per user, 61st → 429", async () => {
    await loginAs("operations_operator", "u-scanner");
    const appt = seedAppointment({ truckPlate: "CAS-9000-Z" });
    const scanBody = {
      appointmentId: appt.id,
      plateRead: "WRONG-PLATE", // mismatch → human-review, never auto-accepts
      confidence: 10,
    };
    for (let i = 0; i < 60; i++) {
      const res = await postScans(postJson("/api/gate/scans", scanBody));
      expect(res.status).toBe(201);
    }
    const limited = await postScans(postJson("/api/gate/scans", scanBody));
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe("rate_limited");
  });

  it("scan rate limit is per-user: a second user still has quota", async () => {
    await loginAs("operations_operator", "u-scanner-a");
    const appt = seedAppointment({ truckPlate: "CAS-9001-Z" });
    const scanBody = { appointmentId: appt.id, plateRead: "WRONG", confidence: 10 };
    for (let i = 0; i < 60; i++) {
      await postScans(postJson("/api/gate/scans", scanBody));
    }
    expect((await postScans(postJson("/api/gate/scans", scanBody))).status).toBe(429);

    await loginAs("operations_operator", "u-scanner-b"); // different user → fresh bucket
    const res = await postScans(postJson("/api/gate/scans", scanBody));
    expect(res.status).toBe(201);
  });
});

// ── 4. GateWatch replay boundary ─────────────────────────────────────────

describe("GateWatch replay boundary (server-side trust)", () => {
  it("rejects client-supplied appointment fields (strict schema → 400)", async () => {
    await loginAs("operations_operator");
    const appt = seedAppointment();
    const res = await postScans(
      postJson("/api/gate/scans", {
        appointmentId: appt.id,
        plateRead: appt.truckPlate,
        confidence: 95,
        // Replay-attack fields: the client must never set these.
        status: "completed",
        truckPlate: "FAKE-0000",
        outcome: "auto-accept",
        simulated: false,
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("validation_error");
    // And nothing was persisted.
    expect(countRows("gate_verification_events")).toBe(0);
  });

  it("auto-accept reflects the DB record: matching scan on a confirmed appointment", async () => {
    await loginAs("operations_operator");
    const appt = seedAppointment({ truckPlate: "CAS-1111-A", containerNo: "TCLU1111111" });
    setAppointmentStatus(db, appt.id, "confirmed"); // confirmed → checked-in is legal

    const res = await postScans(
      postJson("/api/gate/scans", {
        appointmentId: appt.id,
        plateRead: "cas-1111-a", // lowercase — server normalizes
        containerRead: "TCLU1111111",
        confidence: 95,
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.outcome).toBe("auto-accept");
    expect(body.verification.appointmentId).toBe(appt.id);
    expect(body.verification.plateRead).toBe("CAS-1111-A"); // server-normalized
    expect(body.verification.simulated).toBe(true);

    // The persisted event points at appointment A — the ID given, matched
    // against A's DB record. No client field could redirect it.
    const row = db
      .prepare("SELECT appointment_id, plate_read FROM gate_verification_events")
      .get() as { appointment_id: string; plate_read: string };
    expect(row.appointment_id).toBe(appt.id);
    expect(row.plate_read).toBe("CAS-1111-A");
    // And the appointment itself transitioned per the TAS state machine.
    const updated = db
      .prepare("SELECT status FROM appointments WHERE id = ?")
      .get(appt.id) as { status: string };
    expect(updated.status).toBe("checked-in");
  });

  it("mismatched scan data fails closed to human-review against the DB record", async () => {
    await loginAs("operations_operator");
    const apptA = seedAppointment({ truckPlate: "CAS-2222-A" });
    const apptB = seedAppointment({ truckPlate: "CAS-3333-B" });
    setAppointmentStatus(db, apptB.id, "confirmed");

    // Attacker submits A's plate but B's appointmentId: the server compares
    // against B's DB record (the ID given), not any client-supplied plate.
    const res = await postScans(
      postJson("/api/gate/scans", {
        appointmentId: apptB.id,
        plateRead: apptA.truckPlate,
        confidence: 95,
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.outcome).toBe("human-review");
    expect(body.reason).toContain("does not match");
    expect(body.verification.appointmentId).toBe(apptB.id);

    const row = db
      .prepare("SELECT appointment_id FROM gate_verification_events")
      .get() as { appointment_id: string };
    expect(row.appointment_id).toBe(apptB.id); // bound to the given ID's record
    // B was NOT checked in — mismatch never auto-accepts.
    const updated = db
      .prepare("SELECT status FROM appointments WHERE id = ?")
      .get(apptB.id) as { status: string };
    expect(updated.status).toBe("confirmed");
  });

  it("malicious appointmentId (SQLi) is rejected by the UUID contract", async () => {
    await loginAs("operations_operator");
    const res = await postScans(
      postJson("/api/gate/scans", {
        appointmentId: "' OR '1'='1",
        plateRead: "X",
        confidence: 95,
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("validation_error");
  });
});
