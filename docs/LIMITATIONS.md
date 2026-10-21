# Port Operations Intelligence Platform — Limitations

**Last verified:** 2026-10-21 (branch `feat/production-readiness`).
**Policy:** limitations are stated plainly, never concealed, never "fixed" by
inventing data or weakening claims. Each entry gives its honest status, the
evidence, and what is needed to resolve it.

---

## #1 — No real operational dataset (all records synthetic)

**Status: INHERENT — cannot be fixed without real data.**

Every appointment, verification, berth plan, simulation run, and audit event in
the demo database is synthetic. There is no ANP or Marsa Maroc operational data
anywhere in this system, and none was used to build or validate it.

**Evidence of honest labeling:**
- `DEMO — SYNTHETIC DATA` banner and per-page tags whenever the demo seed is
  present in the database (`src/app/layout.tsx`, `src/lib/deployment.ts`) — and
  never on a database that holds only real records.
- Seed records tagged `[SYNTHETIC DEMO DATA]`; the seed is idempotent (stable
  ids + `INSERT OR IGNORE`), so re-running it never duplicates records. Production
  installations are not seeded at all.
- The demo guide (`docs/DEMO-GUIDE.md`) opens with the synthetic-data disclaimer.

**To resolve:** obtain a real operational dataset under a data-sharing agreement
with ANP or a terminal operator (e.g., anonymized truck appointment logs, gate
timestamps, berth schedules). Then: replace the seed, re-validate every KPI
against measured values, and remove the synthetic labels only from surfaces
backed by real data. Until then, every number the demo shows is illustrative.

---

## #2 — Authentication (formerly: demo identities, no passwords)

**Status: RESOLVED — production authentication implemented and tested.**

The passwordless demo identity picker has been replaced:
- **Accounts:** email + scrypt password, password policy, lockout after
  repeated failures, no account enumeration (`src/lib/accounts.ts`).
- **MFA:** RFC 6238 TOTP with QR enrollment, mandatory per role
  (`MFA_REQUIRED_ROLES`, default administrators); seeds encrypted at rest.
- **SSO:** OpenID Connect (code + PKCE, JWKS-verified ID tokens, group → role
  mapping) for the customer's identity provider (`src/lib/oidc.ts`).
- **Sessions:** server-side and revocable (logout, admin sign-out, disable,
  password/MFA reset take effect immediately).
- **CSRF:** origin checks on every state-changing API request, in addition to
  `SameSite=Lax`.
- **Audit:** sign-ins, failures, lockouts, MFA and password changes, session
  revocations and all account administration are recorded and can be shipped
  to a SIEM.

**Evidence:** `src/app/api/auth/auth-routes.test.ts` (end-to-end flows),
`src/lib/auth-primitives.test.ts` (RFC 6238 vectors, scrypt, sealing),
`src/lib/oidc.test.ts` (signature/issuer/audience/nonce rejection, role
mapping, provisioning), `src/middleware.test.ts` (CSRF). Details:
`docs/SECURITY.md`.

**Remaining (operator side):** run an external penetration test before
internet exposure; keep secrets in a secret manager (see `docs/OPERATIONS.md`).

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
| 1 | No real operational dataset | Inherent (customer data required) | Labeled seed + conditional banner; CSV import pipeline ready for real data |
| 2 | Authentication | **Resolved** | Passwords + lockout, TOTP MFA, OIDC SSO, revocable sessions, CSRF checks; auth test suites |
| 3 | GateWatch payload-replay | Dissolved by construction | Server-side load by ID; replay tests green |
| 4 | TAS non-atomic idempotency | Fixed | UNIQUE + `BEGIN IMMEDIATE`; atomicity tests green |
| 5 | BerthWise optimization limits | Inherent | `provenOptimal` gating; 8-vessel ceiling; ALNS excluded |
| 6 | PortTwin uncalibrated | Inherent | `UNCALIBRATED_NOTICE`; provenance labels |

**The rule going forward:** a limitation moves from "inherent" to "resolved"
only with real data, real infrastructure, or a real proof — never by relabeling.
