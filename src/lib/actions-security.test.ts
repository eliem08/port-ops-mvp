// Security & correctness regression tests for the UI server actions and the
// domain module they delegate to (src/lib/actions.ts → src/lib/demo-workflow.ts).
// The UI calls the ACTIONS directly — NOT the REST routes — so every control
// the routes enforce must hold on this path too:
//   1. decideReviewItem: separation of duties — a supervisor cannot decide
//      the review for a scan they submitted (parity with the REST 403).
//   2. decideReviewItem: `decision` is runtime-validated (server-action args
//      cross the network; TS types don't survive — "pending"/garbage must
//      never reach review_items.status).
//   3. recordScanVerification: auto-accept checks the appointment in
//      (parity with POST /api/gate/scans, which transitions to checked-in);
//      an appointment that cannot legally check in degrades to human-review.
//   4. recordScanVerification: event + review-item + check-in persist
//      atomically — a failing review-item insert rolls back the event.
//   5. submitScanAction: throttled at 60/min per user (parity with the REST
//      route's scanRateLimiter).
//   6. submitScanAction: a mid-pipeline failure is NOT misreported as
//      "Appointment not found."
//
// Style: real-auth (like limitations.test.ts) — real JWTs, mocked getDb/audit,
// next/headers, next/cache, next/navigation.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { SignJWT } from "jose";
import { randomUUID } from "node:crypto";
import { freshTestDb } from "@/test-utils/route-harness";
import { scanRateLimiter } from "@/lib/rate-limit";

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
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

const { decideReviewAction, submitScanAction } = await import("@/lib/actions");
const {
  recordScanVerification,
  decideReviewItem,
} = await import("@/lib/demo-workflow");
const { getAppointment } = await import("@/lib/appointments");

const FALLBACK_SECRET = new TextEncoder().encode("dev-only-change-me-in-production");
const COOKIE_NAME = "portops_demo_session";

async function signSession(role: string, userId: string): Promise<string> {
  return await new SignJWT({ userId, label: "Test User", role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(FALLBACK_SECRET);
}

async function loginAs(role: string, userId: string): Promise<void> {
  mockState.cookieJar.set(COOKIE_NAME, await signSession(role, userId));
}

let db: DatabaseSync;
beforeEach(() => {
  db = freshTestDb();
  mockState.db = db;
  mockState.cookieJar.clear();
  scanRateLimiter.reset();
});

function seedAppointment(status = "confirmed"): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO appointments
     (id, truck_plate, container_no, driver_name, scheduled_at, status, created_by, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    "CAS-4821-A",
    "TCLU4829103",
    "Test Driver",
    new Date().toISOString(), // inside the ±1h slot window
    status,
    "u-op",
    randomUUID()
  );
  return id;
}

function scanForm(appointmentId: string, confidence: string): FormData {
  const fd = new FormData();
  fd.set("appointmentId", appointmentId);
  fd.set("plateRead", "CAS-4821-A");
  fd.set("containerRead", "TCLU4829103");
  fd.set("confidence", confidence);
  return fd;
}

function countRows(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("decideReviewItem — separation of duties (parity with REST 403)", () => {
  it("a supervisor CANNOT decide the review for a scan they submitted (domain)", async () => {
    const apptId = seedAppointment();
    const scan = await recordScanVerification(db, "u-sup", {
      appointmentId: apptId,
      plateRead: "CAS-4821-A",
      containerRead: "TCLU4829103",
      confidence: 50,
    });
    expect(scan.outcome).toBe("human-review");
    expect(scan.reviewId).not.toBeNull();

    expect(() =>
      decideReviewItem(db, scan.reviewId!, "u-sup", "approved", "")
    ).toThrow(/separation of duties/i);
    const status = (
      db.prepare("SELECT status FROM review_items WHERE id = ?").get(scan.reviewId!) as {
        status: string;
      }
    ).status;
    expect(status).toBe("pending"); // untouched
  });

  it("a supervisor CANNOT decide their own scan's review via the UI action", async () => {
    await loginAs("supervisor", "u-sup");
    const apptId = seedAppointment();
    const scan = await submitScanAction(scanForm(apptId, "50"));
    expect(scan.ok).toBe(true);
    expect(scan.outcome).toBe("human-review");

    const reviewId = (
      db.prepare("SELECT id FROM review_items").get() as { id: string }
    ).id;
    const res = await decideReviewAction(reviewId, "approved", "");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/separation of duties/i);
  });

  it("a DIFFERENT supervisor can still decide the review", async () => {
    const apptId = seedAppointment();
    const scan = await recordScanVerification(db, "u-op", {
      appointmentId: apptId,
      plateRead: "CAS-4821-A",
      containerRead: "TCLU4829103",
      confidence: 50,
    });
    const decided = decideReviewItem(db, scan.reviewId!, "u-sup2", "approved", "fine");
    expect(decided.status).toBe("approved");
  });
});

describe("decideReviewItem — runtime decision validation", () => {
  it("rejects a hostile 'pending' decision instead of writing it to the DB", async () => {
    const apptId = seedAppointment();
    const scan = await recordScanVerification(db, "u-op", {
      appointmentId: apptId,
      plateRead: "CAS-4821-A",
      containerRead: "TCLU4829103",
      confidence: 50,
    });
    // Server-action args cross the network: TS types don't apply.
    expect(() =>
      decideReviewItem(db, scan.reviewId!, "u-sup2", "pending" as never, "")
    ).toThrow(/invalid review decision input/);
    const status = (
      db.prepare("SELECT status FROM review_items WHERE id = ?").get(scan.reviewId!) as {
        status: string;
      }
    ).status;
    expect(status).toBe("pending");
  });

  it("rejects garbage decisions", async () => {
    const apptId = seedAppointment();
    const scan = await recordScanVerification(db, "u-op", {
      appointmentId: apptId,
      plateRead: "CAS-4821-A",
      containerRead: "TCLU4829103",
      confidence: 50,
    });
    expect(() =>
      decideReviewItem(db, scan.reviewId!, "u-sup2", "definitely-approved" as never, "")
    ).toThrow(/invalid review decision input/);
  });

  it("the UI action maps an invalid decision to a form error, not a DB write", async () => {
    await loginAs("supervisor", "u-sup2");
    const apptId = seedAppointment();
    const scan = await submitScanAction(scanForm(apptId, "50"));
    expect(scan.ok).toBe(true);
    const reviewId = (
      db.prepare("SELECT id FROM review_items").get() as { id: string }
    ).id;
    const res = await decideReviewAction(reviewId, "pending" as never, "");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/invalid decision/i);
  });
});

describe("recordScanVerification — auto-accept checks the appointment in (REST parity)", () => {
  it("a matching high-confidence scan transitions the appointment to checked-in", async () => {
    const apptId = seedAppointment("confirmed");
    const r = await recordScanVerification(db, "u-op", {
      appointmentId: apptId,
      plateRead: "CAS-4821-A",
      containerRead: "TCLU4829103",
      confidence: 95,
    });
    expect(r.outcome).toBe("auto-accept");
    expect(r.checkedIn).toBe(true);
    expect(r.reviewId).toBeNull();
    expect(getAppointment(db, apptId)?.status).toBe("checked-in");
  });

  it("an already checked-in appointment degrades to human-review instead of erroring", async () => {
    const apptId = seedAppointment("checked-in");
    const r = await recordScanVerification(db, "u-op", {
      appointmentId: apptId,
      plateRead: "CAS-4821-A",
      containerRead: "TCLU4829103",
      confidence: 95,
    });
    expect(r.outcome).toBe("human-review");
    expect(r.checkedIn).toBe(false);
    expect(r.reviewId).not.toBeNull();
    expect(r.note).toMatch(/cannot transition to checked-in/i);
    // The downgrade note is persisted on the event for the audit trail.
    const reason = (
      db
        .prepare("SELECT reason FROM gate_verification_events WHERE id = ?")
        .get(r.eventId) as { reason: string }
    ).reason;
    expect(reason).toMatch(/cannot transition to checked-in/i);
  });

  it("the UI action surfaces the check-in on auto-accept", async () => {
    await loginAs("operations_operator", "u-op");
    const apptId = seedAppointment("confirmed");
    const res = await submitScanAction(scanForm(apptId, "95"));
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe("auto-accept");
    expect(getAppointment(db, apptId)?.status).toBe("checked-in");
  });
});

describe("recordScanVerification — atomic persistence", () => {
  it("a failing review-item insert rolls back the verification event (no orphans)", async () => {
    const apptId = seedAppointment();

    // Proxy the DB so the review_items INSERT blows up after the event INSERT.
    const real = db;
    const throwingDb = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("INSERT INTO review_items")) {
              throw new Error("boom: review insert failed");
            }
            return (target.prepare as (s: string) => unknown)(sql);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });

    await expect(
      recordScanVerification(throwingDb as unknown as DatabaseSync, "u-op", {
        appointmentId: apptId,
        plateRead: "CAS-4821-A",
        containerRead: "TCLU4829103",
        confidence: 50,
      })
    ).rejects.toThrow(/boom: review insert failed/);
    expect(countRows("gate_verification_events")).toBe(0); // rolled back
    expect(countRows("review_items")).toBe(0);
  });

  it("a mid-pipeline failure is NOT misreported as 'Appointment not found' by the action", async () => {
    await loginAs("operations_operator", "u-op");
    const apptId = seedAppointment();
    const real = db;
    const throwingDb = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("INSERT INTO review_items")) {
              throw new Error("boom: review insert failed");
            }
            return (target.prepare as (s: string) => unknown)(sql);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    mockState.db = throwingDb as unknown as DatabaseSync;

    await expect(submitScanAction(scanForm(apptId, "50"))).rejects.toThrow(
      /boom: review insert failed/
    );
    expect(countRows("gate_verification_events")).toBe(0);
  });
});

describe("submitScanAction — rate limiting (REST parity: 60/min per user)", () => {
  it("the 61st scan in a minute is rejected", async () => {
    await loginAs("operations_operator", "u-op");
    const apptId = seedAppointment("confirmed");

    for (let i = 0; i < 60; i++) {
      const r = await submitScanAction(scanForm(apptId, "50"));
      expect(r.ok).toBe(true);
    }
    const denied = await submitScanAction(scanForm(apptId, "50"));
    expect(denied.ok).toBe(false);
    expect(denied.message).toMatch(/too many scan submissions/i);
  }, 30000);
});
