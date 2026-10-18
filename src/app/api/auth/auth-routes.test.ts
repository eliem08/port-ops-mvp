// Route tests for /api/auth/login, /api/auth/me, /api/auth/logout.
// Style 2 (like planning/runs/route.test.ts): the REAL auth logic (JWT
// sign/verify, role parsing) runs; only "next/headers" (cookie jar) and
// "@/lib/db/client" (fresh in-memory DB per test) are mocked.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { NextRequest } from "next/server";
import { freshTestDb } from "@/test-utils/route-harness";

const cookieState = vi.hoisted(() => ({
  store: new Map<string, string>(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieState.store.get(name);
      return value === undefined ? undefined : { value };
    },
    set: (name: string, value: string) => {
      cookieState.store.set(name, value);
    },
    delete: (name: string) => {
      cookieState.store.delete(name);
    },
  }),
}));

const getDbMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db/client", () => ({ getDb: getDbMock }));

import { POST as postLogin } from "./login/route";
import { GET as getMe } from "./me/route";
import { POST as postLogout } from "./logout/route";

const COOKIE_NAME = "portops_demo_session";

let db: DatabaseSync;
beforeEach(() => {
  db = freshTestDb();
  cookieState.store.clear();
  getDbMock.mockReset();
  getDbMock.mockReturnValue(db);
  db.prepare(
    "INSERT INTO demo_users (id, label, role) VALUES (?, ?, ?)"
  ).run("demo-operator", "Omar (Operator)", "operations_operator");
  db.prepare(
    "INSERT INTO demo_users (id, label, role) VALUES (?, ?, ?)"
  ).run("demo-supervisor", "Karim (Supervisor)", "supervisor");
});

function loginReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function auditActions(): string[] {
  return (
    db.prepare("SELECT action FROM audit_events ORDER BY rowid").all() as Array<{
      action: string;
    }>
  ).map((r) => r.action);
}

// ── POST /api/auth/login ─────────────────────────────────────────────────

describe("POST /api/auth/login", () => {
  it("200 for a known demo user; sets the session cookie; audits auth.login", async () => {
    const res = await postLogin(loginReq({ userId: "demo-operator" }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    const setCookie = res.headers.getSetCookie();
    expect(setCookie.some((c) => c.startsWith(`${COOKIE_NAME}=`))).toBe(true);
    expect(
      setCookie.some((c) => c.toLowerCase().includes("httponly"))
    ).toBe(true);

    expect(auditActions()).toContain("auth.login");
  });

  it("401 unknown_demo_user for an id that is not in demo_users", async () => {
    const res = await postLogin(loginReq({ userId: "mallory" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unknown_demo_user");
    expect(auditActions()).not.toContain("auth.login");
  });

  it("400 on missing userId / wrong type / extra field", async () => {
    for (const body of [{}, { userId: 42 }, { userId: "demo-operator", extra: 1 }]) {
      const res = await postLogin(loginReq(body));
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");
    }
  });

  it("400 on an empty body and on malformed JSON", async () => {
    const empty = await postLogin(
      new NextRequest("http://localhost/api/auth/login", { method: "POST" })
    );
    expect(empty.status).toBe(400);

    const malformed = await postLogin(loginReq("{nope"));
    expect(malformed.status).toBe(400);
  });

  it("the issued cookie authenticates a later /api/auth/me call", async () => {
    const loginRes = await postLogin(loginReq({ userId: "demo-supervisor" }));
    const raw = loginRes.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${COOKIE_NAME}=`))!;
    const token = raw.slice(COOKIE_NAME.length + 1).split(";")[0];
    cookieState.store.set(COOKIE_NAME, token);

    const me = await getMe();
    expect(me.status).toBe(200);
    const body = await me.json();
    expect(body.user.userId).toBe("demo-supervisor");
    expect(body.user.role).toBe("supervisor");
    expect(body.user.label).toBe("Karim (Supervisor)");
  });
});

// ── GET /api/auth/me ─────────────────────────────────────────────────────

describe("GET /api/auth/me", () => {
  it("401 when there is no session cookie", async () => {
    const res = await getMe();
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthenticated");
  });

  it("401 for a tampered/forged token (fail closed)", async () => {
    cookieState.store.set(COOKIE_NAME, "forged.not-a-real-token");
    const res = await getMe();
    expect(res.status).toBe(401);
  });
});

// ── POST /api/auth/logout ────────────────────────────────────────────────

describe("POST /api/auth/logout", () => {
  it("200 with a session: clears the cookie and audits auth.logout", async () => {
    const loginRes = await postLogin(loginReq({ userId: "demo-operator" }));
    const raw = loginRes.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${COOKIE_NAME}=`))!;
    cookieState.store.set(
      COOKIE_NAME,
      raw.slice(COOKIE_NAME.length + 1).split(";")[0]
    );

    const res = await postLogout();
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(auditActions()).toContain("auth.logout");

    // Cookie cleared: the maxAge=0 drop-cookie wins in the jar.
    const cleared = res.headers.getSetCookie();
    expect(
      cleared.some(
        (c) =>
          c.startsWith(`${COOKIE_NAME}=`) &&
          (c.includes("Max-Age=0") || c.includes("Expires=Thu, 01 Jan 1970"))
      )
    ).toBe(true);
    expect(cookieState.store.has(COOKIE_NAME)).toBe(false);
  });

  it("200 without a session; no auth.logout audit written", async () => {
    const res = await postLogout();
    expect(res.status).toBe(200);
    expect(auditActions()).not.toContain("auth.logout");
  });
});
