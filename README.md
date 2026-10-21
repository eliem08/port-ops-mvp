# Port Operations Intelligence

Decision support for container-terminal and port operations, in one application:

- **Truck appointments (TAS):** book, confirm and track truck slots, with atomic idempotency and a strict status machine. Bulk-import from your terminal or appointment-system CSV exports.
- **Gate verification (GateWatch):** check each gate scan (plate, container ISO 6346, OCR confidence) against the appointment held server-side. Clean matches can be accepted automatically; anything doubtful goes to a supervisor review queue. You decide how much is automatic.
- **Berth planning (BerthWise):** assign vessels to berths with an exact solver (proven-optimal results are labeled as such) and labeled heuristics for larger instances.
- **Operations simulation (PortTwin):** compare reproducible what-if scenarios side by side, including a direct bridge from today's appointment volume.

Built for regulated operators: individual accounts with MFA or your own single sign-on, five roles, server-enforced permissions, an append-only audit trail you can ship to your SIEM, and a human-in-the-loop policy switch.

> Independent product. Not affiliated with ANP, Marsa Maroc or any port authority or terminal operator. The bundled demo seed is synthetic and clearly labeled in the UI whenever it is present.

---

## Run it

### Docker (recommended)

```bash
cp .env.example .env
# Set at least: AUTH_SECRET, DATA_ENCRYPTION_KEY, BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD
docker compose up -d                     # http://localhost:3000
docker compose --profile tls up -d       # + automatic HTTPS via Caddy (set APP_DOMAIN)
```

The container applies database migrations at start-up and creates the first administrator from `BOOTSTRAP_ADMIN_*`. That administrator must change the password, and enroll an authenticator app, at first sign-in. Full guide: **[docs/OPERATIONS.md](docs/OPERATIONS.md)**.

### Local development / sales demo

```bash
npm install
npm run db:migrate
npm run db:seed        # synthetic demo data + 5 demo accounts; prints the demo password once
npm run dev            # http://localhost:3000
```

The demo accounts are `viewer@`, `operator@`, `planner@`, `supervisor@` and `admin@demo.portops.local`. Set `MFA_REQUIRED_ROLES=""` in `.env` if you don't want the demo administrator to be asked for MFA. A guided 15-minute walkthrough is in [docs/DEMO-GUIDE.md](docs/DEMO-GUIDE.md), with a French version in [docs/pilot/DEMO-SCRIPT-FR.md](docs/pilot/DEMO-SCRIPT-FR.md).

---

## What's inside

| Area | Capabilities |
|---|---|
| **Identity & access** | Email + password (scrypt, lockout, password policy); TOTP MFA with QR enrollment, mandatory per role; OpenID Connect SSO (Entra ID, Keycloak, Okta, Google…) with group → role mapping; server-side sessions with instant revocation; forced password change for new and reset accounts. |
| **Roles** | `operations_viewer` < `operations_operator` = `planner` < `supervisor` < `administrator`. Enforced on every API route, server action and page. |
| **Administration** | Users (create, role, disable, unlock, reset password/MFA, force sign-out); operating policy; audit trail viewer and CSV export; online backups. |
| **Human in the loop** | Turn automatic gate acceptance off (every scan → supervisor), or raise the OCR confidence required above the 70 floor. Every change is audited. |
| **Data intake** | Appointments CSV import (comma or semicolon, BOM-tolerant), row-level validation report, dry run, all-or-nothing commit, safe re-imports via `external_ref`. CSV export for reporting/BI. |
| **Audit** | Append-only trail of sign-ins, failures, lockouts, account and policy changes, imports, every operational action. Filter, export, and stream to a SIEM webhook (at-least-once, resumable). |
| **Operations** | Docker image (non-root, read-only rootfs), automatic migrations, `/api/health` + `/api/ready`, Prometheus `/api/metrics`, structured JSON logs, scheduled and on-demand verified backups, restore CLI. |
| **Security** | CSRF origin checks, strict CSP (no `unsafe-eval` in production), HSTS, MFA seeds encrypted at rest (AES-256-GCM), parameterized SQL, strict input contracts, sanitized errors, rate limits, dependency audit gate and secret scanning in CI. |

## Architecture

```
Browser ──► Next.js (App Router)
              ├─ middleware: CSRF check, signed-cookie fast path
              ├─ pages + server actions ─┐
              └─ REST API routes ────────┼─► auth/session (SQLite-backed) ─► role check
                                         ├─► Zod contracts (strict)
                                         ├─► domain logic: TAS · GateWatch · BerthWise · PortTwin
                                         └─► SQLite (WAL) ─► audit_events ─► SIEM webhook
```

The domain logic is vendored verbatim from the four module repositories (see `src/vendored/*/VENDORED.md`). The platform supplies persistence, identity, policy, audit and operations around it. More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/INTEGRATION-MATRIX.md](docs/INTEGRATION-MATRIX.md).

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Develop, build, serve |
| `npm run lint` / `typecheck` / `test` | Quality gates (CI runs all of them) |
| `npm run db:migrate` | Apply migrations (the server also does this at start-up) |
| `npm run db:seed` | Load the synthetic demo data and demo accounts |
| `npm run user:create-admin` | Create an administrator (`ADMIN_EMAIL=… npm run user:create-admin`) |
| `npm run db:backup` / `db:restore -- <file>` | Verified online backup / restore |
| `npm run db:reset` | Wipe a development database (refuses in production) |

## Known limits (stated plainly)

1. **Your data, your calibration.** The simulator is uncalibrated until it is fitted to your observed operations, and every simulator surface says so. Solver run times must be benchmarked on your real instance sizes. See [docs/LIMITATIONS.md](docs/LIMITATIONS.md).
2. **Gate input.** The GateWatch UI submits scans by hand. Camera/ANPR systems integrate through `POST /api/gate/scans` (same verification path).
3. **Single-node database.** SQLite in WAL mode with verified backups suits a single terminal's workload on one host. Multi-node high availability would require a PostgreSQL port; the trade-offs are written up in [docs/pilot/SQLITE-ASSESSMENT.md](docs/pilot/SQLITE-ASSESSMENT.md).
4. **Independent assurance.** The controls are covered by 346 automated tests, but an external penetration test is still to be commissioned before internet exposure.

Security details: [docs/SECURITY.md](docs/SECURITY.md) · Pilot readiness: [docs/pilot/PILOT-READINESS-CHECKLIST.md](docs/pilot/PILOT-READINESS-CHECKLIST.md)
