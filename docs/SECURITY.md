# Security — Port Operations Intelligence Platform (MVP)

**Scope:** this is a *demo* system. It implements real server-side security
mechanics (auth, role checks, validation, parameterized SQL, audit trail) but
runs on demo credentials, synthetic data, and a local SQLite file. This
document states what is protected, what is explicitly not, and what production
would require.

## 1. Threat model

### Protected

| Control | Where | Notes |
|---|---|---|
| Server-side authentication | `src/middleware.ts`, `src/lib/auth.ts` | Every route except `/login`, `/api/auth/*`, `/api/health` requires a valid HS256 JWT. Middleware fails closed: API → 401 JSON, pages → redirect to `/login`. |
| Role enforcement | `requireApiRole(req, minRole)` on every consequential route; `requireRole()` in server actions | Rank hierarchy: `operations_viewer`(0) < `operations_operator`(1) = `planner`(1) < `supervisor`(2) < `administrator`(3). UI buttons are cosmetic; the server decides. Invalid/expired tokens fail closed (`getSession()` returns null). |
| Input validation | Zod `.strict()` schemas in `src/contracts/index.ts` on every route | UTC-Z datetimes, UUID ids, bounded strings, numeric ranges (e.g. simulation overrides: replications 10–500, horizon ≤ 168 h). Request bodies capped at 1 MB (`readJsonLimited`). |
| SQL injection | Parameterized prepared statements everywhere | `node:sqlite` `prepare("… WHERE id = ?")` — no string interpolation of user input. Audit details store scalar values only. |
| GateWatch payload-replay risk | Server-side DB lookup by ID | **DISSOLVED BY CONSTRUCTION (limitation #3):** `POST /api/gate/scans` loads the appointment from SQLite by `appointmentId`. Client-supplied appointment data is never trusted, so a stale/forged payload cannot replay a cancelled appointment. See scan-route comment "THE TRUSTED BOUNDARY". |
| TAS concurrent idempotency | SQLite UNIQUE constraints + transactions | **FIXED (limitation #4):** `appointments.idempotency_key TEXT UNIQUE`; `berth_plans UNIQUE(input_hash, solver)`; `simulation_runs.input_hash UNIQUE`; plus `withTransaction()` (BEGIN IMMEDIATE/COMMIT/ROLLBACK) around multi-row writes. Atomic check-and-create, no double rows on retry. |
| Fail-closed verification | Vendored `review.ts` + regression tests | NaN, missing, or out-of-range confidence → NEVER auto-accepts (locked by `review.regression.test.ts`, 8 tests). |
| Audit trail | `src/lib/audit.ts` → `audit_events` table | Append-only by convention and code review — no UPDATE or DELETE queries exist anywhere. Login/logout, creates, transitions, scans, review decisions, plan and simulation runs are all logged with actor + timestamp. Detail fields are scalar-only (no PII, request bodies, or secrets). |
| Error handling | `handleRouteError()` | Sanitized `{ error: { code, message } }` envelope; never stack traces or internals. Unexpected errors are logged server-side. |
| Session cookie | `setSessionCookie()` | `httpOnly`, `SameSite=Lax`, `Secure` in production, 8 h expiry (`SESSION_TTL_SECONDS` in `src/lib/auth.ts`; JWT `exp` and cookie `maxAge` share the constant), path `/`. |

### Explicitly NOT protected (demo scope)

- **Demo auth is not a real identity provider.** Five hard-coded demo identities
  (`demo-viewer` … `demo-admin`), no passwords — picking a name on the login
  page *is* the login. Anyone who can reach the server can log in as any role.
- **No secrets management.** `DEMO_AUTH_SECRET` lives in a local `.env` with a
  fallback default (`dev-only-change-me-in-production`). Compromise of the
  secret = session forgery. There is no rotation, no vault, no KMS.
- **SQLite file permissions.** The database is a local file (`dev.db`). Whoever
  can read the file can read everything; whoever can write it owns the data.
  No encryption at rest, no row-level security.
- **No CSRF tokens beyond SameSite.** `SameSite=Lax` cookies are the only CSRF
  mitigation; there are no per-request anti-CSRF tokens (Lax blocks cross-site
  POST, but strict or token-based protection would be needed for production).
- **Rate limiting** (demo-grade, in-memory): the login route is throttled at
  10 attempts/min per IP (`loginRateLimiter`, keyed by `clientIp()`); scan
  submission is throttled at 60/min per authenticated user
  (`scanRateLimiter`, keyed `user:<userId>`). Token-bucket
  (`src/lib/rate-limit.ts`); single-process memory, resets on restart, no
  clustering — not a production solution. Over-limit calls get
  `429 { error: { code: "rate_limited" } }` with a `Retry-After` header.
- **No dependency audit gate** in this repo (upstream repos track advisories
  via Dependabot; see INTEGRATION-MATRIX for the four source repos).
- **Server-action path note:** `src/lib/actions.ts` uses a dynamic
  `await import("@/vendored/gatewatch/verify")` inside the scan action and a
  demo `slotStart/End = scheduled_at ± 1 h` window — adequate for the demo, but
  slot-window semantics would need to come from the real scheduling data in
  production.

## 2. Auth design

- **Token:** HS256 JWT signed with `DEMO_AUTH_SECRET`, payload
  `{ userId, label, role }`, 8 h expiry (`SESSION_TTL_SECONDS`,
  `createSession`).
- **Transport:** `portops_demo_session` httpOnly cookie.
- **Lookup:** sessions are stateless; the role is asserted at login from the
  `demo_users` table and embedded in the JWT (`getSession()` re-validates the
  signature and parses the role through the `DemoRole` enum).
- **Roles (5):** `operations_viewer` (read-only), `operations_operator`
  (appointments + scans), `planner` (runs planning/simulations), `supervisor`
  (review decisions + everything below), `administrator` (highest rank).
- **Middleware verification (shared secret, separate call site):** the edge
  middleware cannot import `node:sqlite`, so JWT verification runs there
  independently via `jwtVerify`, but it now reads the same secret through the
  single source of truth (`src/lib/auth-secret.ts` — the duplicated fallback
  string was removed on 2026-10-18). Cookie name and secret no longer drift;
  if the verification *logic* ever changes in one place, change it in both
  (`src/lib/auth.ts` and `src/middleware.ts`) — drift here silently breaks
  the gate.

## 3. The six documented limitations (accurate status)

| # | Limitation | Status |
|---|---|---|
| 1 | No real operational dataset — all records synthetic | **Open by design.** Seed data is labeled `[SYNTHETIC DEMO DATA]`; UI carries a permanent `DEMO — SYNTHETIC DATA` banner. |
| 2 | Demo auth providers, not a real IdP | **Open by design.** See "Explicitly NOT protected" above. |
| 3 | GateWatch payload-replay risk | **DISSOLVED BY CONSTRUCTION.** Appointment is loaded server-side by ID; client appointment data is never trusted. |
| 4 | TAS non-atomic idempotency | **FIXED.** SQLite UNIQUE constraints + transactions; see §1. |
| 5 | BerthWise optimization limits | **Documented.** Exact solver: hard ceiling of 8 vessels (`EXACT_MAX_VESSELS`); ALNS vendored but excluded from interactive paths (superlinear); heuristics are labeled non-optimal. `berth_plans.proven_optimal` is 1 only for the exact solver. |
| 6 | PortTwin uncalibrated | **Documented.** `simulation_runs.calibrated = 0` always; `UNCALIBRATED_NOTICE` on every surface; KPI figures are provenance-labeled `simulated`/`assumed`, never `measured`. |

## 4. What production would need

1. **Real identity provider** (OIDC/SAML) with MFA; per-user credentials;
   session revocation; secret in a vault with rotation.
2. **CSRF tokens** (or SameSite=Strict + origin checks) on state-changing routes.
3. **Rate limiting** on all API routes (there is vendored TAS rate-limit code to
   start from).
4. **Database migration to a real RDBMS** (Postgres) with TLS, encryption at
   rest, backups, and row-level access control; file-permission risk disappears.
5. **Secrets management** — no credentials in `.env` files on disk; inject at
   runtime.
6. **Production WAF/logging** — structured audit shipping to a SIEM, anomaly
   alerts on review-queue bypass attempts.
7. **Dependency audit gate** in CI (the upstream repos already run Dependabot;
   the platform needs its own `npm audit` gate).
8. **HTTPS everywhere** (Secure cookies already conditional on `NODE_ENV`).
9. **Real data governance** before any BerthWise/PortTwin output is presented
   as fact: calibration of the simulator against observed data, and solver
   benchmarks on real instance sizes.
