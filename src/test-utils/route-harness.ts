// Shared harness for API route tests.
// Two supported styles (both established in this repo):
//  1. Mocked style (like simulate-routes.test.ts): vi.mock "@/lib/auth"
//     (requireApiRole), "@/lib/db/client" (getDb), "@/lib/audit" (audit).
//     Each test gets a FRESH in-memory SQLite DB via beforeEach — full
//     isolation, fast, no JWT plumbing.
//  2. Real-auth style (like planning/runs/route.test.ts): mock only
//     "next/headers" cookies, sign real JWTs, real audit against a temp DB.
// The helpers below serve style 1. Import the route handlers AFTER the
// vi.mock calls in each test file.

import { vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { NextRequest } from "next/server";
import { MIGRATIONS } from "@/lib/db/migrations";

/** Fresh in-memory SQLite DB with the full migration set applied. */
export function freshTestDb(): DatabaseSync {
  const sqlite = process.getBuiltinModule("node:sqlite") as typeof import(
    "node:sqlite"
  );
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const m of MIGRATIONS) db.exec(m.sql);
  return db;
}

/** vi.fn() handles for the three mocked route dependencies. */
export function makeMocks() {
  return {
    requireApiRole: vi.fn(),
    getDb: vi.fn(),
    audit: vi.fn(),
  };
}
export type RouteMocks = ReturnType<typeof makeMocks>;

/** A Response shaped like the real jsonError() output — throw it from the
 *  requireApiRole mock to simulate 401/403. handleRouteError passes
 *  Response instances through unchanged. */
export function rejectWith(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code, message: code } }), {
    status,
  });
}

/** Fail-closed helper: configure the mock to ACCEPT a session. */
export function allowAs(
  mocks: { requireApiRole: { mockResolvedValue(v: unknown): void } },
  session: DemoSessionLike
): void {
  mocks.requireApiRole.mockResolvedValue(session);
}

/** Fail-closed helper: configure the mock to REJECT with 401/403. */
export function denyWith(
  mocks: { requireApiRole: { mockRejectedValue(v: unknown): void } },
  status: number,
  code: string
): void {
  mocks.requireApiRole.mockRejectedValue(rejectWith(status, code));
}

export interface DemoSessionLike {
  userId: string;
  label: string;
  role: string;
}

export const VIEWER: DemoSessionLike = {
  userId: "u-viewer",
  label: "Viewer",
  role: "operations_viewer",
};
export const OPERATOR: DemoSessionLike = {
  userId: "u-operator",
  label: "Operator",
  role: "operations_operator",
};
export const PLANNER: DemoSessionLike = {
  userId: "u-planner",
  label: "Planner",
  role: "planner",
};
export const SUPERVISOR: DemoSessionLike = {
  userId: "u-supervisor",
  label: "Supervisor",
  role: "supervisor",
};
export const ADMIN: DemoSessionLike = {
  userId: "u-admin",
  label: "Admin",
  role: "administrator",
};

/** POST JSON request against an API route handler. */
export function postJson(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** PATCH JSON request against an API route handler. */
export function patchJson(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** GET request against an API route handler. */
export function getReq(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method: "GET" });
}

/** Reset the mocks and point getDb at a fresh in-memory DB.
 *  `audit` is optional: files that test the REAL audit module omit it. */
export function resetHarness(mocks: {
  requireApiRole: { mockReset(): void };
  getDb: { mockReset(): void; mockReturnValue(db: DatabaseSync): void };
  audit?: { mockClear(): void };
}): DatabaseSync {
  const db = freshTestDb();
  mocks.getDb.mockReset();
  mocks.getDb.mockReturnValue(db);
  mocks.requireApiRole.mockReset();
  mocks.audit?.mockClear();
  return db;
}
