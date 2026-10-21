// Account domain logic: password authentication with lockout, MFA
// enrollment, password changes, and administrator user management.
// Pure functions over a DatabaseSync so routes, server actions and tests all
// exercise the same code. Every state change is audited by the caller-facing
// functions here (audit rows go to the same DB handle).

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AuditAction, Role } from "@/contracts";
import { dummyVerify, hashPassword, needsRehash, passwordPolicyError, verifyPassword } from "./password";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "./totp";
import { open, seal } from "./crypto-box";
import { nowIso, revokeUserSessions } from "./auth";
import { DomainError } from "./errors";

export const MAX_FAILED_LOGINS = Number(process.env.LOCKOUT_THRESHOLD) > 0 ? Number(process.env.LOCKOUT_THRESHOLD) : 5;
export const LOCKOUT_SECONDS = (Number(process.env.LOCKOUT_MINUTES) > 0 ? Number(process.env.LOCKOUT_MINUTES) : 15) * 60;
export const MFA_ISSUER = process.env.MFA_ISSUER || "Port Operations Intelligence";

export class AccountError extends DomainError {}

interface UserRow {
  id: string;
  label: string;
  role: string;
  email: string | null;
  password_hash: string | null;
  failed_logins: number;
  locked_until: string | null;
  mfa_secret: string | null;
  mfa_enabled: number;
  disabled: number;
  must_change_password: number;
  external_subject: string | null;
  last_login_at: string | null;
  created_at: string;
}

export interface UserSummary {
  id: string;
  label: string;
  role: Role;
  email: string | null;
  mfaEnabled: boolean;
  disabled: boolean;
  locked: boolean;
  mustChangePassword: boolean;
  sso: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  activeSessions: number;
}

function writeAudit(
  db: DatabaseSync,
  actorId: string,
  action: AuditAction,
  entityId: string,
  detail: Record<string, string | number | boolean | null> = {}
): void {
  db.prepare(
    `INSERT INTO audit_events (id, actor_id, action, entity, entity_id, detail_json)
     VALUES (?, ?, ?, 'user', ?, ?)`
  ).run(randomUUID(), actorId, action, entityId, JSON.stringify(detail));
}

function getUserRow(db: DatabaseSync, id: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function findUserByEmail(db: DatabaseSync, email: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase()) as
    | UserRow
    | undefined;
}

function isLocked(row: UserRow): boolean {
  return row.locked_until !== null && row.locked_until > nowIso();
}

// ── Authentication ────────────────────────────────────────────────────────

export type PasswordAuthResult =
  | { kind: "ok"; userId: string }
  | { kind: "mfa_required"; userId: string }
  | { kind: "invalid" }
  | { kind: "locked"; until: string };

function recordFailure(db: DatabaseSync, row: UserRow, reason: string): PasswordAuthResult {
  const failures = row.failed_logins + 1;
  if (failures >= MAX_FAILED_LOGINS) {
    const until = nowIso(LOCKOUT_SECONDS);
    db.prepare("UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?").run(until, row.id);
    writeAudit(db, row.id, "auth.account_locked", row.id, { reason, until });
    return { kind: "locked", until };
  }
  db.prepare("UPDATE users SET failed_logins = ? WHERE id = ?").run(failures, row.id);
  writeAudit(db, row.id, "auth.login_failed", row.id, { reason, failures });
  return { kind: "invalid" };
}

/**
 * Verifies email + password. Unknown emails, wrong passwords, disabled and
 * SSO-only accounts all return "invalid" (no account enumeration), with
 * equalized timing. Repeated failures lock the account temporarily.
 */
export function authenticatePassword(db: DatabaseSync, email: string, password: string): PasswordAuthResult {
  const row = findUserByEmail(db, email);
  if (!row || !row.password_hash) {
    dummyVerify(password);
    return { kind: "invalid" };
  }
  if (isLocked(row)) {
    dummyVerify(password);
    return { kind: "locked", until: row.locked_until! };
  }
  if (!verifyPassword(password, row.password_hash)) return recordFailure(db, row, "bad_password");
  if (row.disabled) {
    writeAudit(db, row.id, "auth.login_failed", row.id, { reason: "disabled" });
    return { kind: "invalid" };
  }
  db.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?").run(row.id);
  if (needsRehash(row.password_hash)) {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), row.id);
  }
  return row.mfa_enabled ? { kind: "mfa_required", userId: row.id } : { kind: "ok", userId: row.id };
}

/** Second factor for a user who already passed the password step. */
export function verifyLoginTotp(db: DatabaseSync, userId: string, code: string): PasswordAuthResult {
  const row = getUserRow(db, userId);
  if (!row || row.disabled || !row.mfa_enabled || !row.mfa_secret) return { kind: "invalid" };
  if (isLocked(row)) return { kind: "locked", until: row.locked_until! };
  if (!verifyTotp(open(row.mfa_secret), code)) return recordFailure(db, row, "bad_totp");
  db.prepare("UPDATE users SET failed_logins = 0 WHERE id = ?").run(row.id);
  return { kind: "ok", userId: row.id };
}

// ── Self-service ──────────────────────────────────────────────────────────

export function changePassword(
  db: DatabaseSync,
  userId: string,
  currentPassword: string,
  newPassword: string,
  keepSessionId?: string
): void {
  const row = getUserRow(db, userId);
  if (!row || !row.password_hash) {
    throw new AccountError(400, "no_password", "This account signs in through single sign-on.");
  }
  if (!verifyPassword(currentPassword, row.password_hash)) {
    throw new AccountError(400, "wrong_password", "Current password is incorrect.");
  }
  if (currentPassword === newPassword) {
    throw new AccountError(400, "password_reused", "Choose a password different from the current one.");
  }
  const policy = passwordPolicyError(newPassword, { email: row.email ?? undefined });
  if (policy) throw new AccountError(400, "weak_password", policy);
  db.prepare(
    "UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ? WHERE id = ?"
  ).run(hashPassword(newPassword), nowIso(), userId);
  // Other devices must sign in again with the new password.
  revokeUserSessions(db, userId, keepSessionId);
  writeAudit(db, userId, "auth.password_changed", userId, { self: true });
}

/** Starts (or restarts) TOTP enrollment; MFA stays off until confirmed. */
export function beginMfaEnrollment(db: DatabaseSync, userId: string): { secret: string; otpauthUrl: string } {
  const row = getUserRow(db, userId);
  if (!row) throw new AccountError(404, "not_found", "User not found.");
  if (row.mfa_enabled) {
    throw new AccountError(409, "mfa_already_enabled", "MFA is already enabled. Disable it first to re-enroll.");
  }
  const secret = generateTotpSecret();
  db.prepare("UPDATE users SET mfa_secret = ? WHERE id = ?").run(seal(secret), userId);
  return { secret, otpauthUrl: otpauthUrl(secret, row.email ?? row.id, MFA_ISSUER) };
}

export function confirmMfaEnrollment(db: DatabaseSync, userId: string, code: string): void {
  const row = getUserRow(db, userId);
  if (!row?.mfa_secret) throw new AccountError(400, "no_enrollment", "Start MFA enrollment first.");
  if (row.mfa_enabled) throw new AccountError(409, "mfa_already_enabled", "MFA is already enabled.");
  if (!verifyTotp(open(row.mfa_secret), code)) {
    throw new AccountError(400, "invalid_code", "That code is not valid. Check your device clock and try again.");
  }
  db.prepare("UPDATE users SET mfa_enabled = 1 WHERE id = ?").run(userId);
  writeAudit(db, userId, "auth.mfa_enabled", userId, {});
}

export function disableOwnMfa(db: DatabaseSync, userId: string, password: string, role: Role, required: boolean): void {
  const row = getUserRow(db, userId);
  if (!row?.mfa_enabled) throw new AccountError(400, "mfa_not_enabled", "MFA is not enabled.");
  if (required) {
    throw new AccountError(403, "mfa_required", `MFA is mandatory for the '${role}' role.`);
  }
  if (!verifyPassword(password, row.password_hash)) {
    throw new AccountError(400, "wrong_password", "Password is incorrect.");
  }
  db.prepare("UPDATE users SET mfa_enabled = 0, mfa_secret = NULL WHERE id = ?").run(userId);
  writeAudit(db, userId, "auth.mfa_disabled", userId, { self: true });
}

// ── Administration ────────────────────────────────────────────────────────

function toSummary(db: DatabaseSync, row: UserRow): UserSummary {
  const active = db
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?")
    .get(row.id, nowIso()) as { n: number };
  return {
    id: row.id,
    label: row.label,
    role: row.role as Role,
    email: row.email,
    mfaEnabled: row.mfa_enabled === 1,
    disabled: row.disabled === 1,
    locked: isLocked(row),
    mustChangePassword: row.must_change_password === 1,
    sso: row.external_subject !== null,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    activeSessions: Number(active.n),
  };
}

export function listUsers(db: DatabaseSync): UserSummary[] {
  const rows = db.prepare("SELECT * FROM users ORDER BY label COLLATE NOCASE").all() as unknown as UserRow[];
  return rows.map((r) => toSummary(db, r));
}

export function getUserSummary(db: DatabaseSync, id: string): UserSummary | null {
  const row = getUserRow(db, id);
  return row ? toSummary(db, row) : null;
}

export function createUser(
  db: DatabaseSync,
  actorId: string,
  input: { email: string; label: string; role: Role; password: string; mustChangePassword?: boolean }
): UserSummary {
  const email = input.email.trim().toLowerCase();
  if (findUserByEmail(db, email)) {
    throw new AccountError(409, "email_taken", "A user with this email already exists.");
  }
  const policy = passwordPolicyError(input.password, { email });
  if (policy) throw new AccountError(400, "weak_password", policy);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, label, role, email, password_hash, must_change_password, password_changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.label, input.role, email, hashPassword(input.password), input.mustChangePassword === false ? 0 : 1, nowIso());
  writeAudit(db, actorId, "user.created", id, { role: input.role });
  return getUserSummary(db, id)!;
}

export function updateUser(
  db: DatabaseSync,
  actorId: string,
  id: string,
  patch: {
    label?: string;
    role?: Role;
    disabled?: boolean;
    unlock?: true;
    resetPassword?: string;
    resetMfa?: true;
  }
): UserSummary {
  const row = getUserRow(db, id);
  if (!row) throw new AccountError(404, "not_found", "User not found.");
  const selfEdit = actorId === id;
  if (selfEdit && (patch.disabled === true || (patch.role && patch.role !== row.role))) {
    throw new AccountError(400, "self_lockout", "You cannot disable yourself or change your own role.");
  }
  const demotingAdmin = row.role === "administrator" && ((patch.role && patch.role !== "administrator") || patch.disabled);
  if (demotingAdmin) {
    const admins = db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'administrator' AND disabled = 0")
      .get() as { n: number };
    if (Number(admins.n) <= 1) {
      throw new AccountError(400, "last_admin", "At least one active administrator must remain.");
    }
  }

  const changed: string[] = [];
  if (patch.label !== undefined && patch.label !== row.label) {
    db.prepare("UPDATE users SET label = ? WHERE id = ?").run(patch.label, id);
    changed.push("label");
  }
  if (patch.role !== undefined && patch.role !== row.role) {
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(patch.role, id);
    changed.push("role");
  }
  if (patch.disabled !== undefined && (patch.disabled ? 1 : 0) !== row.disabled) {
    db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(patch.disabled ? 1 : 0, id);
    if (patch.disabled) revokeUserSessions(db, id);
    changed.push(patch.disabled ? "disabled" : "enabled");
  }
  if (patch.unlock) {
    db.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?").run(id);
    changed.push("unlocked");
  }
  if (patch.resetPassword !== undefined) {
    const policy = passwordPolicyError(patch.resetPassword, { email: row.email ?? undefined });
    if (policy) throw new AccountError(400, "weak_password", policy);
    db.prepare(
      "UPDATE users SET password_hash = ?, must_change_password = 1, password_changed_at = ?, failed_logins = 0, locked_until = NULL WHERE id = ?"
    ).run(hashPassword(patch.resetPassword), nowIso(), id);
    revokeUserSessions(db, id);
    changed.push("password_reset");
  }
  if (patch.resetMfa) {
    db.prepare("UPDATE users SET mfa_enabled = 0, mfa_secret = NULL WHERE id = ?").run(id);
    revokeUserSessions(db, id);
    changed.push("mfa_reset");
  }
  if (changed.length > 0) {
    writeAudit(db, actorId, "user.updated", id, {
      changes: changed.join(","),
      ...(patch.role ? { role: patch.role } : {}),
    });
  }
  return getUserSummary(db, id)!;
}

export function revokeSessionsByAdmin(db: DatabaseSync, actorId: string, id: string): number {
  if (!getUserRow(db, id)) throw new AccountError(404, "not_found", "User not found.");
  const n = revokeUserSessions(db, id);
  writeAudit(db, actorId, "auth.session_revoked", id, { count: n, scope: "all" });
  return n;
}

export interface SessionSummary {
  id: string;
  authMethod: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
}

export function listActiveSessions(db: DatabaseSync, userId: string): SessionSummary[] {
  return (
    db
      .prepare(
        `SELECT id, auth_method, ip, user_agent, created_at, expires_at FROM sessions
         WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`
      )
      .all(userId, nowIso()) as Array<{
      id: string;
      auth_method: string;
      ip: string | null;
      user_agent: string | null;
      created_at: string;
      expires_at: string;
    }>
  ).map((s) => ({
    id: s.id,
    authMethod: s.auth_method,
    ip: s.ip,
    userAgent: s.user_agent,
    createdAt: s.created_at,
    expiresAt: s.expires_at,
  }));
}
