// Route tests for authentication, account self-service and user admin.
// Real auth logic end to end (scrypt, TOTP, server-side sessions, JWT
// sign/verify); only "next/headers" (cookie jar) and "@/lib/db/client"
// (fresh in-memory DB per test) are mocked.

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
import { POST as postMfa } from "./mfa/route";
import { GET as getMe } from "./me/route";
import { POST as postLogout } from "./logout/route";
import { POST as postPassword } from "../account/password/route";
import { POST as postAccountMfa } from "../account/mfa/route";
import { GET as getMySessions, DELETE as deleteMySessions } from "../account/sessions/route";
import { GET as listUsersRoute, POST as createUserRoute } from "../admin/users/route";
import { PATCH as patchUserRoute } from "../admin/users/[id]/route";
import { DELETE as revokeUserSessionsRoute } from "../admin/users/[id]/sessions/route";
import { GET as listAppointments } from "../appointments/route";
import { createUser, beginMfaEnrollment, confirmMfaEnrollment, MAX_FAILED_LOGINS } from "@/lib/accounts";
import { totpAt } from "@/lib/totp";
import { loginRateLimiter } from "@/lib/rate-limit";
import { SESSION_COOKIE as COOKIE_NAME } from "@/test-utils/sessions";

const PASSWORD = "correct-horse-battery-staple";

let db: DatabaseSync;
beforeEach(() => {
  db = freshTestDb();
  cookieState.store.clear();
  getDbMock.mockReset();
  getDbMock.mockReturnValue(db);
  loginRateLimiter.reset();
});

function json(path: string, body: unknown, method = "POST"): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", "user-agent": "vitest" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const get = (path: string, method = "GET") => new NextRequest(`http://localhost${path}`, { method });

function auditActions(): string[] {
  return (
    db.prepare("SELECT action FROM audit_events ORDER BY rowid").all() as Array<{ action: string }>
  ).map((r) => r.action);
}

/** Creates an active account (no forced password change). */
function makeUser(email: string, role: Parameters<typeof createUser>[2]["role"], opts: { mfa?: boolean } = {}) {
  const user = createUser(db, "test", { email, label: email.split("@")[0], role, password: PASSWORD, mustChangePassword: false });
  if (opts.mfa) {
    const { secret } = beginMfaEnrollment(db, user.id);
    confirmMfaEnrollment(db, user.id, totpAt(secret, Math.floor(Date.now() / 1000)));
    return { ...user, secret };
  }
  return { ...user, secret: null as string | null };
}

/** Moves the session cookie from a response into the mocked jar. */
function adopt(res: Response): string {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!raw) throw new Error("no session cookie set");
  const token = raw.slice(COOKIE_NAME.length + 1).split(";")[0];
  cookieState.store.set(COOKIE_NAME, token);
  return token;
}

async function signIn(email: string, password = PASSWORD): Promise<string> {
  const res = await postLogin(json("/api/auth/login", { email, password }));
  expect(res.status).toBe(200);
  return adopt(res);
}

// ── POST /api/auth/login ─────────────────────────────────────────────────

describe("POST /api/auth/login", () => {
  it("200 with correct credentials: httpOnly session cookie, server-side session row, audit", async () => {
    const u = makeUser("omar@example.com", "operations_operator");
    const res = await postLogin(json("/api/auth/login", { email: "Omar@Example.com ", password: PASSWORD }));
    expect(res.status).toBe(200);
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`))!;
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    const sessions = db.prepare("SELECT user_id, auth_method FROM sessions").all() as Array<{ user_id: string; auth_method: string }>;
    expect(sessions).toEqual([{ user_id: u.id, auth_method: "password" }]);
    expect(auditActions()).toContain("auth.login");
  });

  it("401 invalid_credentials for a wrong password and for an unknown email (same response)", async () => {
    makeUser("omar@example.com", "operations_operator");
    const wrong = await postLogin(json("/api/auth/login", { email: "omar@example.com", password: "not-the-password" }));
    const unknown = await postLogin(json("/api/auth/login", { email: "ghost@example.com", password: "not-the-password" }));
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401);
      expect((await res.json()).error).toEqual({ code: "invalid_credentials", message: "Invalid email or password." });
    }
    expect(auditActions()).toContain("auth.login_failed");
  });

  it(`locks the account after ${MAX_FAILED_LOGINS} failures — even the right password is refused (423)`, async () => {
    makeUser("omar@example.com", "operations_operator");
    for (let i = 0; i < MAX_FAILED_LOGINS - 1; i++) {
      expect((await postLogin(json("/api/auth/login", { email: "omar@example.com", password: "nope-nope-nope" }))).status).toBe(401);
    }
    const locking = await postLogin(json("/api/auth/login", { email: "omar@example.com", password: "nope-nope-nope" }));
    expect(locking.status).toBe(423);
    const correct = await postLogin(json("/api/auth/login", { email: "omar@example.com", password: PASSWORD }));
    expect(correct.status).toBe(423);
    expect((await correct.json()).error.code).toBe("account_locked");
    expect(auditActions()).toContain("auth.account_locked");
  });

  it("401 for a disabled account with the correct password", async () => {
    const u = makeUser("omar@example.com", "operations_operator");
    db.prepare("UPDATE users SET disabled = 1 WHERE id = ?").run(u.id);
    const res = await postLogin(json("/api/auth/login", { email: "omar@example.com", password: PASSWORD }));
    expect(res.status).toBe(401);
  });

  it("400 on missing fields / extra field / malformed JSON / empty body", async () => {
    for (const body of [{}, { email: "a@b.co" }, { email: "a@b.co", password: "x", userId: "demo-admin" }, "{nope"]) {
      expect((await postLogin(json("/api/auth/login", body))).status).toBe(400);
    }
    expect((await postLogin(new NextRequest("http://localhost/api/auth/login", { method: "POST" }))).status).toBe(400);
  });
});

// ── MFA sign-in ──────────────────────────────────────────────────────────

describe("MFA sign-in (POST /api/auth/login → POST /api/auth/mfa)", () => {
  it("password step returns a challenge and no session; a valid code completes sign-in", async () => {
    const u = makeUser("karim@example.com", "supervisor", { mfa: true });
    const step1 = await postLogin(json("/api/auth/login", { email: "karim@example.com", password: PASSWORD }));
    expect(step1.status).toBe(200);
    const body = await step1.json();
    expect(body.mfaRequired).toBe(true);
    expect(step1.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE_NAME}=`))).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });

    const code = totpAt(u.secret!, Math.floor(Date.now() / 1000));
    const step2 = await postMfa(json("/api/auth/mfa", { challenge: body.challenge, code }));
    expect(step2.status).toBe(200);
    adopt(step2);
    const me = await (await getMe()).json();
    expect(me.user.authMethod).toBe("password+totp");
    expect(me.user.mfaEnabled).toBe(true);
  });

  it("wrong code → 401; forged challenge → 401 challenge_expired", async () => {
    makeUser("karim@example.com", "supervisor", { mfa: true });
    const { challenge } = await (await postLogin(json("/api/auth/login", { email: "karim@example.com", password: PASSWORD }))).json();
    expect((await postMfa(json("/api/auth/mfa", { challenge, code: "000000" }))).status).toBe(401);
    const forged = await postMfa(json("/api/auth/mfa", { challenge: "eyJhbGciOiJIUzI1NiJ9.e30.x", code: "123456" }));
    expect((await forged.json()).error.code).toBe("challenge_expired");
  });

  it("a session token cannot be replayed as an MFA challenge", async () => {
    makeUser("omar@example.com", "operations_operator");
    const token = await signIn("omar@example.com");
    const res = await postMfa(json("/api/auth/mfa", { challenge: token, code: "123456" }));
    expect((await res.json()).error.code).toBe("challenge_expired");
  });
});

// ── me / logout / revocation ─────────────────────────────────────────────

describe("sessions are server-side", () => {
  it("/api/auth/me reflects the account; 401 without or with a forged cookie", async () => {
    makeUser("salma@example.com", "planner");
    expect((await getMe()).status).toBe(401);
    cookieState.store.set(COOKIE_NAME, "forged.not-a-real-token");
    expect((await getMe()).status).toBe(401);
    await signIn("salma@example.com");
    const body = await (await getMe()).json();
    expect(body.user).toMatchObject({ role: "planner", email: "salma@example.com", restricted: null });
  });

  it("logout revokes the session: replaying the old cookie is rejected", async () => {
    makeUser("omar@example.com", "operations_operator");
    const token = await signIn("omar@example.com");
    const res = await postLogout();
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE_NAME}=`) && c.includes("Max-Age=0"))).toBe(true);
    expect(auditActions()).toContain("auth.logout");
    cookieState.store.set(COOKIE_NAME, token); // attacker kept a copy
    expect((await getMe()).status).toBe(401);
  });

  it("disabling a user ends their session immediately", async () => {
    const u = makeUser("omar@example.com", "operations_operator");
    await signIn("omar@example.com");
    db.prepare("UPDATE users SET disabled = 1 WHERE id = ?").run(u.id);
    expect((await getMe()).status).toBe(401);
  });

  it("'sign out other sessions' keeps the current one", async () => {
    makeUser("omar@example.com", "operations_operator");
    const first = await signIn("omar@example.com");
    const second = await signIn("omar@example.com");
    const list = await (await getMySessions(get("/api/account/sessions"))).json();
    expect(list.sessions).toHaveLength(2);
    expect((await (await deleteMySessions(get("/api/account/sessions", "DELETE"))).json()).revoked).toBe(1);
    expect((await getMe()).status).toBe(200); // current (second) still valid
    cookieState.store.set(COOKIE_NAME, first);
    expect((await getMe()).status).toBe(401);
    cookieState.store.set(COOKIE_NAME, second);
  });
});

// ── restricted sessions ──────────────────────────────────────────────────

describe("restricted sessions (forced password change, required MFA)", () => {
  it("must_change_password blocks the app (403 account_setup_required) until the password is changed", async () => {
    createUser(db, "admin", { email: "new@example.com", label: "New", role: "operations_viewer", password: PASSWORD });
    await signIn("new@example.com");
    const blocked = await listAppointments(get("/api/appointments"));
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error.code).toBe("account_setup_required");

    const weak = await postPassword(json("/api/account/password", { currentPassword: PASSWORD, newPassword: "short" }));
    expect((await weak.json()).error.code).toBe("weak_password");
    const changed = await postPassword(
      json("/api/account/password", { currentPassword: PASSWORD, newPassword: "a-much-better-passphrase-2026" })
    );
    expect(changed.status).toBe(200);
    expect((await listAppointments(get("/api/appointments"))).status).toBe(200);
    expect(auditActions()).toContain("auth.password_changed");
  });

  it("administrators without MFA are restricted until they enroll; enrollment lifts it", async () => {
    makeUser("root@example.com", "administrator");
    await signIn("root@example.com");
    expect((await listUsersRoute(get("/api/admin/users"))).status).toBe(403);

    const begin = await (await postAccountMfa(json("/api/account/mfa", { action: "begin" }))).json();
    expect(begin.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const stored = db.prepare("SELECT mfa_secret FROM users WHERE email = 'root@example.com'").get() as { mfa_secret: string };
    expect(stored.mfa_secret).not.toContain(begin.secret); // sealed at rest

    const bad = await postAccountMfa(json("/api/account/mfa", { action: "confirm", code: "000000" }));
    expect(bad.status).toBe(400);
    const code = totpAt(begin.secret, Math.floor(Date.now() / 1000));
    expect((await postAccountMfa(json("/api/account/mfa", { action: "confirm", code }))).status).toBe(200);
    expect((await listUsersRoute(get("/api/admin/users"))).status).toBe(200);
    // Required role: MFA cannot be switched off.
    const disable = await postAccountMfa(json("/api/account/mfa", { action: "disable", password: PASSWORD }));
    expect((await disable.json()).error.code).toBe("mfa_required");
  });
});

// ── user administration ──────────────────────────────────────────────────

describe("/api/admin/users", () => {
  async function asAdmin() {
    const admin = makeUser("root@example.com", "administrator", { mfa: true });
    const { challenge } = await (await postLogin(json("/api/auth/login", { email: "root@example.com", password: PASSWORD }))).json();
    adopt(await postMfa(json("/api/auth/mfa", { challenge, code: totpAt(admin.secret!, Math.floor(Date.now() / 1000)) })));
    return admin;
  }

  it("403 for non-administrators", async () => {
    makeUser("karim@example.com", "supervisor");
    await signIn("karim@example.com");
    expect((await listUsersRoute(get("/api/admin/users"))).status).toBe(403);
    expect((await createUserRoute(json("/api/admin/users", {}))).status).toBe(403);
  });

  it("creates accounts (forced password change), rejects duplicates and weak passwords", async () => {
    await asAdmin();
    const created = await createUserRoute(
      json("/api/admin/users", { email: "Yasmine@Example.com", label: "Yasmine", role: "operations_viewer", password: PASSWORD })
    );
    expect(created.status).toBe(201);
    expect((await created.json()).user).toMatchObject({ email: "yasmine@example.com", mustChangePassword: true });
    const dup = await createUserRoute(
      json("/api/admin/users", { email: "yasmine@example.com", label: "Y2", role: "operations_viewer", password: PASSWORD })
    );
    expect(dup.status).toBe(409);
    const weak = await createUserRoute(
      json("/api/admin/users", { email: "z@example.com", label: "Z", role: "operations_viewer", password: "password1234" })
    );
    expect((await weak.json()).error.code).toBe("weak_password");
    expect(auditActions()).toContain("user.created");
  });

  it("guards: no self-disable, no self-demotion, the last administrator stays", async () => {
    const admin = await asAdmin();
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
    const selfDisable = await patchUserRoute(json(`/api/admin/users/${admin.id}`, { disabled: true }, "PATCH"), ctx(admin.id));
    expect((await selfDisable.json()).error.code).toBe("self_lockout");
    const selfDemote = await patchUserRoute(json("/x", { role: "planner" }, "PATCH"), ctx(admin.id));
    expect((await selfDemote.json()).error.code).toBe("self_lockout");
    // Demoting another admin works while at least one active admin remains.
    const other = makeUser("second@example.com", "administrator", { mfa: true });
    expect((await patchUserRoute(json("/x", { role: "supervisor" }, "PATCH"), ctx(other.id))).status).toBe(200);
  });

  it("disable / unlock / reset password / force sign-out all take effect", async () => {
    await asAdmin();
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
    const target = makeUser("omar@example.com", "operations_operator");
    db.prepare("INSERT INTO sessions (id, user_id, auth_method, expires_at) VALUES ('s-1', ?, 'password', '2999-01-01T00:00:00Z')").run(target.id);

    const revoked = await revokeUserSessionsRoute(get("/x", "DELETE"), ctx(target.id));
    expect((await revoked.json()).revoked).toBe(1);

    db.prepare("UPDATE users SET locked_until = '2999-01-01T00:00:00Z' WHERE id = ?").run(target.id);
    const unlocked = await (await patchUserRoute(json("/x", { unlock: true }, "PATCH"), ctx(target.id))).json();
    expect(unlocked.user.locked).toBe(false);

    const reset = await (await patchUserRoute(json("/x", { resetPassword: "temporary-pass-2026!" }, "PATCH"), ctx(target.id))).json();
    expect(reset.user.mustChangePassword).toBe(true);

    const disabled = await (await patchUserRoute(json("/x", { disabled: true }, "PATCH"), ctx(target.id))).json();
    expect(disabled.user.disabled).toBe(true);
    expect(auditActions().filter((a) => a === "user.updated").length).toBeGreaterThanOrEqual(3);
  });
});
