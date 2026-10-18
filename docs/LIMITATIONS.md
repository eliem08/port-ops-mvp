# Port Operations Intelligence Platform — Limitations

**Last verified:** 2026-10-18 (branch `feat/mvp-slice-1`).
**Policy:** limitations are stated plainly, never concealed, never "fixed" by
inventing data or weakening claims. Each entry gives its honest status, the
evidence, and what ilyass would need to do to resolve it.

---

## #1 — No real operational dataset (all records synthetic)

**Status: INHERENT — cannot be fixed without real data.**

Every appointment, verification, berth plan, simulation run, and audit event in
the demo database is synthetic. There is no ANP or Marsa Maroc operational data
anywhere in this system, and none was used to build or validate it.

**Evidence of honest labeling:**
- Permanent `DEMO — SYNTHETIC DATA` banner in the app shell (`src/app/layout.tsx`).
- Seed records tagged `[SYNTHETIC DEMO DATA]`; the seed script refuses to run
  against a non-empty database without `--force`.
- The demo guide (`docs/DEMO-GUIDE.md`) opens with the synthetic-data disclaimer.

**To resolve:** obtain a real operational dataset under a data-sharing agreement
with ANP or a terminal operator (e.g., anonymized truck appointment logs, gate
timestamps, berth schedules). Then: replace the seed, re-validate every KPI
against measured values, and remove the synthetic labels only from surfaces
backed by real data. Until then, every number the demo shows is illustrative.

---

## #2 — Demo authentication, not a production identity provider

**Status: HARDENED (as far as possible without a real IdP) — still DEMO.**

What was hardened in this pass:
- **Session expiry:** 8-hour absolute timeout (JWT `exp` + cookie `maxAge`,
  kept in sync via `SESSION_TTL_SECONDS` in `src/lib/auth.ts`).
- **Cookie flags:** `httpOnly`, `SameSite=Lax`, `Secure` in production.
- **Startup refusal:** `src/instrumentation.ts` runs at server boot and
  `src/lib/auth-secret.ts` throws on every use when `NODE_ENV=production`
  and `DEMO_AUTH_SECRET` is unset, a publicly known placeholder, or shorter
  than 32 characters. The app **refuses to start** rather than serve forgeable
  sessions. (The refusal is skipped during `next build`, which never serves
  traffic.)
- **Single source of truth:** the secret lives in `src/lib/auth-secret.ts`,
  shared by `src/lib/auth.ts` and the edge `src/middleware.ts` — the previous
  duplicated fallback string (a split-brain risk) is gone.
- **Audit:** logins and logins are written to the append-only audit trail
  (`auth.login` / `auth.logout`).
- **Rate limiting:** login endpoint throttled (10/min/IP); scan endpoint
  throttled per user (60/min).
- **Boot banner:** every server start prints the demo-auth limitations to the
  log so no operator mistakes this for production auth.

What is still missing (and why this remains DEMO):
- Password hashing, MFA, account recovery, session revocation list.
- Brute-force account lockout (rate limiting is not lockout).
- Per-user secrets, secret rotation, vault-backed storage.
- Audit shipping to a SIEM; anomaly alerts.
- CSRF tokens (currently relying on `SameSite=Lax` + no state-changing GETs).

**To resolve:** integrate a real identity provider (OIDC/SAML — e.g., Keycloak,
Authentik, or the customer's existing IdP) with MFA enforced; move sessions to
server-side storage with revocation; put secrets in a vault with rotation.
Nothing in the demo auth should be carried over except the role model.

---

## #3 — GateWatch payload-replay risk

**Status: DISSOLVED BY CONSTRUCTION — verified by tests.**

The original risk: a client could replay a stale or forged appointment payload
(e.g., a scan for an appointment that has since been cancelled) and have it
accepted as if the appointment were still valid.

Why it cannot happen here:
- `POST /api/gate/scans` accepts only `SubmitScanInput` (`.strict()` Zod
  schema): `appointmentId`, `plateRead`, `containerRead`, `confidence`.
  Any client-supplied appointment field (`status`, `truckPlate`, `outcome`,
  …) is rejected with `400 validation_error` — nothing is persisted.
- The appointment is loaded **server-side from SQLite by `appointmentId`**
  on every request (`getAppointment(db, input.appointmentId)`).
- The verification outcome is computed against the **current** DB record:
  scan data is compared to the stored plate/container, and auto-accept
  requires the stored status to legally transition to `checked-in`.

**Verification (new tests in `src/lib/limitations.test.ts`):**
- *Stale-payload replay:* a valid scan auto-accepts while the appointment is
  `confirmed`; the **identical** payload replayed after cancellation yields
  `human-review` (reason cites the `cancelled` status) and the appointment is
  NOT moved to `checked-in`. This proves the server re-reads DB state per
  request.
- *Status gating:* a high-confidence matching scan on a `requested`
  appointment yields `human-review`, never auto-accept.
- (Strict-schema rejection of forged fields was already covered in
  `src/lib/security.test.ts` §4.)

---

## #4 — TAS concurrent idempotency (non-atomic check-and-create)

**Status: FIXED — verified by tests.**

The original defect (found in the standalone TAS repo): the
check-if-key-exists → insert-appointment sequence was not atomic, so two
concurrent requests with the same idempotency key could create two rows.

The fix in the platform:
- `idempotency_keys(key TEXT PRIMARY KEY)` + `appointments.idempotency_key
  TEXT UNIQUE` (migrations).
- `createAppointment()` runs `INSERT OR IGNORE INTO idempotency_keys`
  inside `withTransaction()` (`BEGIN IMMEDIATE`), so the claim and the
  insert are a single atomic unit. A duplicate key returns the **existing**
  record (`created: false`, HTTP `200`) instead of inserting.

**Verification (new tests in `src/lib/limitations.test.ts`):**
- Sequential duplicates with the same key → same record ID, exactly 1 row.
- HTTP-level: `POST /api/appointments` twice with the same key → `201`
  then `200`, same ID, 1 row.
- Cross-connection mutual exclusion: two independent SQLite connections to
  the same file; connection A takes `BEGIN IMMEDIATE` and claims the key;
  connection B's `BEGIN IMMEDIATE` throws `SQLITE_BUSY` (proves the write
  lock); after A commits, B's `INSERT OR IGNORE` is a no-op (`changes: 0`).
- Different keys still create different appointments (no over-dedup).

---

## #5 — BerthWise optimization limits

**Status: INHERENT — documented, labeled, not weakened.**

- The exact solver has a hard ceiling of **8 vessels** (`EXACT_MAX_VESSELS`);
  larger instances automatically fall back to heuristics with an
  `exactUnavailableReason` shown in the UI.
- ALNS is vendored but **excluded from all interactive paths** (superlinear
  scaling — documented in `docs/INTEGRATION-MATRIX.md`).
- The word "optimal" appears in the UI **only** when `provenOptimal` is true,
  which only the exact solver sets after exhausting its search. Heuristic
  results are labeled `HEURISTIC — <solver> (result quality not certified)`.
  (`src/app/planning/optimality-banner.tsx`; verified by inspection.)
- Infeasible vessels are reported as unassigned with reasons, never silently
  dropped or crashed.

**To resolve:** benchmark the solvers on real instance sizes from ANP data;
calibrate the node cap / time limits against operational requirements; decide
with the customer whether heuristic quality guarantees (e.g., MIP gaps) are
needed before any plan is presented as actionable. No algorithmic change in
this demo would honestly improve the limits — they are properties of the
problem sizes, not bugs.

---

## #6 — PortTwin uncalibrated

**Status: INHERENT — documented, labeled, not faked.**

- `simulation_runs.calibrated = 0` always; there is no calibration path in
  the demo.
- `UNCALIBRATED_NOTICE` is rendered on every simulator surface
  (`src/lib/simulation.ts`, `/simulate` pages).
- Every KPI carries a provenance label: `simulated` or `assumed` — never
  `measured`. Every scenario parameter is labeled `assumed`.
- Simulation runs are seeded and reproducible, which is a correctness
  property, not a validity claim.

**To resolve:** calibrate against real operational data — fit arrival rates,
service-time distributions, and disruption frequencies to observed port data;
validate predicted vs. actual KPIs out-of-sample; then and only then replace
the uncalibrated notice with a calibration report (method, data window,
goodness-of-fit). Calibrating against synthetic data would be fabrication and
is explicitly out of scope.

---

## Summary

| # | Limitation | Status | Evidence |
|---|---|---|---|
| 1 | No real operational dataset | Inherent | `DEMO — SYNTHETIC DATA` banner; labeled seeds |
| 2 | Demo auth, not a real IdP | Hardened (still demo) | 8h expiry; startup refusal; audit; rate limits |
| 3 | GateWatch payload-replay | Dissolved by construction | Server-side load by ID; replay tests green |
| 4 | TAS non-atomic idempotency | Fixed | UNIQUE + `BEGIN IMMEDIATE`; atomicity tests green |
| 5 | BerthWise optimization limits | Inherent | `provenOptimal` gating; 8-vessel ceiling; ALNS excluded |
| 6 | PortTwin uncalibrated | Inherent | `UNCALIBRATED_NOTICE`; provenance labels |

**The rule going forward:** a limitation moves from "inherent" to "resolved"
only with real data, real infrastructure, or a real proof — never by relabeling.
