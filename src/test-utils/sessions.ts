// Real-auth test helpers: create a user + server-side session row and sign a
// session cookie exactly as src/lib/auth.ts does, so tests exercise the real
// verification path (signature, expiry, revocation, role parsing).

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { SignJWT } from "jose";

export const SESSION_COOKIE = "portops_session";
// auth-secret.ts falls back to this secret in tests (vitest does not load .env).
export const FALLBACK_SECRET = new TextEncoder().encode("dev-only-change-me-in-production");

/** Inserts (or updates) a password-less test user. Administrators get MFA
 *  marked enabled so the default "admins need MFA" rule doesn't restrict them. */
export function ensureTestUser(
  db: DatabaseSync,
  userId: string,
  role: string,
  opts: { label?: string; mfaEnabled?: boolean; mustChangePassword?: boolean } = {}
): void {
  const mfa = opts.mfaEnabled ?? role === "administrator";
  db.prepare(
    `INSERT INTO users (id, label, role, mfa_enabled, must_change_password) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET role = excluded.role, mfa_enabled = excluded.mfa_enabled,
       must_change_password = excluded.must_change_password`
  ).run(userId, opts.label ?? "Test User", role, mfa ? 1 : 0, opts.mustChangePassword ? 1 : 0);
}

export interface TestSessionOptions {
  secret?: Uint8Array;
  /** jose expiration, e.g. "2h" or "-1h" for an already-expired token */
  exp?: string;
  label?: string;
  mfaEnabled?: boolean;
  mustChangePassword?: boolean;
}

/** Creates user + session rows and returns a signed cookie value. */
export async function signTestSession(
  db: DatabaseSync,
  role: string,
  userId = "u-test",
  opts: TestSessionOptions = {}
): Promise<string> {
  ensureTestUser(db, userId, role, opts);
  const sid = randomUUID();
  db.prepare(
    "INSERT INTO sessions (id, user_id, auth_method, expires_at) VALUES (?, ?, 'password', ?)"
  ).run(sid, userId, new Date(Date.now() + 3600_000).toISOString());
  return await new SignJWT({ sid })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "2h")
    .sign(opts.secret ?? FALLBACK_SECRET);
}
