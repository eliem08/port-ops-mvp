// Authentication and sessions.
// - Accounts: email + scrypt password (src/lib/password.ts), optional TOTP
//   MFA (src/lib/totp.ts), or OIDC single sign-on (src/lib/oidc.ts).
// - Sessions are SERVER-SIDE rows in `sessions`. The httpOnly cookie holds a
//   signed JWT carrying only the session id; every request re-checks the row
//   (revoked? expired? user disabled?), so logout, admin revocation and
//   account disabling take effect immediately.
// - The edge middleware only verifies the JWT signature (it cannot reach
//   SQLite); the authoritative check is getSession(), which every page
//   (via the root layout), API route (requireApiRole) and server action
//   (requireRole in actions.ts) goes through.
// - "Restricted" sessions (must change password, or MFA enrollment required
//   for the role) can only reach the account endpoints until resolved.
//
// CSRF: cookie is SameSite=Lax + httpOnly (+ Secure in production) and the
// middleware rejects cross-origin state-changing API requests (Origin /
// Sec-Fetch-Site check). Server actions carry Next.js's built-in origin check.

import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Role } from "@/contracts";
import { getDb } from "./db/client";
import { getSecretBytes } from "./auth-secret";

export const COOKIE_NAME = "portops_session";

/** Absolute session lifetime — JWT exp, cookie maxAge and sessions.expires_at match. */
export const SESSION_TTL_SECONDS = Math.round(
  (Number(process.env.SESSION_TTL_HOURS) > 0 ? Number(process.env.SESSION_TTL_HOURS) : 8) * 3600
);

const secret = getSecretBytes();

export type AuthMethod = "password" | "password+totp" | "oidc";
export type SessionRestriction = "must_change_password" | "mfa_enrollment_required";

export interface Session {
  sessionId: string;
  userId: string;
  label: string;
  role: Role;
  email: string | null;
  authMethod: AuthMethod;
  mfaEnabled: boolean;
  /** Non-null when the account must finish setup before using the app. */
  restricted: SessionRestriction | null;
}
/** @deprecated legacy name — use Session. */
export type DemoSession = Session;

// Role hierarchy for requireRole: higher roles inherit lower permissions.
export const ROLE_RANK: Record<Role, number> = {
  operations_viewer: 0,
  operations_operator: 1,
  planner: 1,
  supervisor: 2,
  administrator: 3,
};

export function hasRole(role: Role, minRole: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

/** Roles that must enroll TOTP before using the app (password logins only;
 *  SSO users get MFA from their identity provider). Default: administrators. */
export function mfaRequiredForRole(role: Role): boolean {
  const raw = process.env.MFA_REQUIRED_ROLES ?? "administrator";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(role);
}

export function nowIso(offsetSeconds = 0): string {
  return new Date(Date.now() + offsetSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function createSession(
  userId: string,
  opts: { authMethod?: AuthMethod; ip?: string | null; userAgent?: string | null; db?: DatabaseSync } = {}
): Promise<string> {
  const db = opts.db ?? getDb();
  const row = db.prepare("SELECT id, disabled FROM users WHERE id = ?").get(userId) as
    | { id: string; disabled: number }
    | undefined;
  if (!row) throw new Error("unknown user");
  if (row.disabled) throw new Error("user disabled");
  const sid = randomUUID();
  db.prepare(
    `INSERT INTO sessions (id, user_id, auth_method, ip, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    sid,
    userId,
    opts.authMethod ?? "password",
    opts.ip ?? null,
    opts.userAgent?.slice(0, 300) ?? null,
    nowIso(SESSION_TTL_SECONDS)
  );
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(nowIso(), userId);
  return await new SignJWT({ sid })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secret);
}

interface SessionRow {
  sid: string;
  auth_method: string;
  expires_at: string;
  revoked_at: string | null;
  id: string;
  label: string;
  role: string;
  email: string | null;
  disabled: number;
  mfa_enabled: number;
  must_change_password: number;
}

/** Loads and validates a session by id. Null when missing, revoked, expired
 *  or the user is disabled — always fail closed. */
export function loadSession(db: DatabaseSync, sid: string, userId?: string): Session | null {
  const row = db
    .prepare(
      `SELECT s.id AS sid, s.auth_method, s.expires_at, s.revoked_at,
              u.id, u.label, u.role, u.email, u.disabled, u.mfa_enabled, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`
    )
    .get(sid) as SessionRow | undefined;
  if (!row) return null;
  if (userId !== undefined && row.id !== userId) return null;
  if (row.revoked_at || row.disabled) return null;
  if (row.expires_at <= nowIso()) return null;
  const role = Role.safeParse(row.role);
  if (!role.success) return null;
  const authMethod = row.auth_method as AuthMethod;
  let restricted: SessionRestriction | null = null;
  if (row.must_change_password && authMethod !== "oidc") restricted = "must_change_password";
  else if (authMethod !== "oidc" && !row.mfa_enabled && mfaRequiredForRole(role.data)) {
    restricted = "mfa_enrollment_required";
  }
  return {
    sessionId: row.sid,
    userId: row.id,
    label: row.label,
    role: role.data,
    email: row.email,
    authMethod,
    mfaEnabled: row.mfa_enabled === 1,
    restricted,
  };
}

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    if (typeof payload.sid !== "string" || typeof payload.sub !== "string") return null;
    return loadSession(getDb(), payload.sid, payload.sub);
  } catch {
    return null; // fail closed: invalid token = no session
  }
}

export function revokeSession(db: DatabaseSync, sid: string): void {
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(nowIso(), sid);
}

/** Revokes every active session of a user, optionally keeping one (the caller's). */
export function revokeUserSessions(db: DatabaseSync, userId: string, exceptSid?: string): number {
  const res = db
    .prepare(
      "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?"
    )
    .run(nowIso(), userId, exceptSid ?? null);
  return Number(res.changes);
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE_NAME);
}

/**
 * Server-side role guard for API routes. Throws a 401/403 Response on failure.
 * Usage: const session = await requireApiRole(req, "operations_operator");
 * Fail-closed: no session, invalid/revoked token, restricted account or
 * insufficient role → error. Account-setup endpoints pass allowRestricted.
 */
export async function requireApiRole(
  _req: NextRequest,
  minRole: Role,
  opts: { allowRestricted?: boolean } = {}
): Promise<Session> {
  const session = await getSession();
  if (!session) {
    throw jsonError(401, "unauthenticated", "Sign-in required.");
  }
  if (session.restricted && !opts.allowRestricted) {
    throw jsonError(
      403,
      "account_setup_required",
      session.restricted === "must_change_password"
        ? "You must change your password before continuing."
        : "Your role requires multi-factor authentication. Enroll an authenticator app first."
    );
  }
  if (!hasRole(session.role, minRole)) {
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

export function sessionCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

export function setSessionCookie(res: NextResponse, token: string): void {
  res.cookies.set(COOKIE_NAME, token, sessionCookieOptions(SESSION_TTL_SECONDS));
}

export function clearSessionCookie(res: NextResponse): void {
  // Flags must MIRROR setSessionCookie — a Secure cookie set in production
  // is NOT cleared by a deletion response that omits `secure: true`.
  res.cookies.set(COOKIE_NAME, "", sessionCookieOptions(0));
}

// ── Short-lived signed tokens (MFA challenge, OIDC state) ──────────────────

export async function signPurposeToken(
  purpose: string,
  claims: Record<string, string>,
  ttlSeconds: number
): Promise<string> {
  return await new SignJWT({ ...claims, purpose })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret);
}

export async function verifyPurposeToken(
  token: string,
  purpose: string
): Promise<Record<string, unknown> | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    return payload.purpose === purpose ? payload : null;
  } catch {
    return null;
  }
}
