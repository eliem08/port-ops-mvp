// Demo authentication — EXPLICITLY NOT PRODUCTION AUTH.
// - Signed JWT in an httpOnly cookie. No passwords (demo identities only).
// - Every consequential API route MUST call requireRole() server-side.
// - The UI displays a permanent DEMO banner; this must never be mistaken
//   for a real identity provider.
//
// CSRF POSTURE (documented, not just assumed):
// - The session cookie is httpOnly + SameSite=Lax (+ Secure in production).
//   SameSite=Lax means cross-site POST/PUT/PATCH/DELETE do NOT carry the
//   cookie — only top-level GET navigations do, and this API has no
//   state-changing GET routes. So classic CSRF against the mutation routes
//   is blocked at the cookie layer for modern browsers.
// - Login CSRF is a non-issue here: login is passwordless and picks one of
//   the PUBLIC demo identities (listed on the login page); there is no
//   victim credential to fixate.
// - If this ever grows real credentials: add an anti-CSRF token (double-
//   submit or synchronizer) on all mutations, rotate the signing secret,
//   and shorten the 12h session lifetime.

import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { DemoRole } from "@/contracts";
import { getDb } from "./db/client";

const COOKIE_NAME = "portops_demo_session";

const rawSecret = process.env.DEMO_AUTH_SECRET;
if (!rawSecret && process.env.NODE_ENV === "production") {
  // Loud fail-open warning: anyone with the repo default could forge
  // sessions. Demo only — never ship without a real secret.
  console.error(
    "[auth] DEMO_AUTH_SECRET is not set in production — sessions are signed " +
      "with a publicly known fallback. This demo must not be exposed publicly."
  );
}
const secret = new TextEncoder().encode(
  rawSecret ?? "dev-only-change-me-in-production"
);

export interface DemoSession {
  userId: string;
  label: string;
  role: DemoRole;
}

// Role hierarchy for requireRole: higher roles inherit lower permissions.
const ROLE_RANK: Record<DemoRole, number> = {
  operations_viewer: 0,
  operations_operator: 1,
  planner: 1,
  supervisor: 2,
  administrator: 3,
};

export async function createSession(userId: string): Promise<string> {
  const db = getDb();
  const row = db
    .prepare("SELECT id, label, role FROM demo_users WHERE id = ?")
    .get(userId) as { id: string; label: string; role: string } | undefined;
  if (!row) throw new Error("unknown demo user");
  const role = DemoRole.parse(row.role);
  return await new SignJWT({ userId: row.id, label: row.label, role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(secret);
}

export async function getSession(): Promise<DemoSession | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret);
    return {
      userId: payload.userId as string,
      label: payload.label as string,
      role: DemoRole.parse(payload.role),
    };
  } catch {
    return null; // fail closed: invalid token = no session
  }
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE_NAME);
}

/**
 * Server-side role guard for API routes. Throws a 401/403 Response on failure.
 * Usage: const session = await requireApiRole(req, "operations_operator");
 * Fail-closed: no session, invalid token, or insufficient role → error.
 */
export async function requireApiRole(
  _req: NextRequest,
  minRole: DemoRole
): Promise<DemoSession> {
  const session = await getSession();
  if (!session) {
    throw jsonError(401, "unauthenticated", "Demo login required.");
  }
  if (ROLE_RANK[session.role] < ROLE_RANK[minRole]) {
    throw jsonError(
      403,
      "forbidden",
      `Role '${session.role}' cannot perform this action (requires '${minRole}').`
    );
  }
  return session;
}

export function jsonError(status: number, code: string, message: string): Response {
  // Sanitized envelope — never leaks internals.
  return NextResponse.json({ error: { code, message } }, { status });
}

export function setSessionCookie(res: NextResponse, token: string): void {
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 12 * 3600,
  });
}
