# Demo Guide — Port Operations Intelligence Platform

**Audience:** ANP / Marsa Maroc stakeholders. **Duration:** ~15 minutes.
**Everything on screen is synthetic demo data.** The banner says
`DEMO — SYNTHETIC DATA` on every page — point it out at minute 0.

> Speaker rule: say what is simulated *before* showing it. Each limitation
> below has a one-sentence "what to say" line. Use it verbatim.

## 0. Setup (before the meeting)

```bash
npm install
npm run db:migrate   # creates schema
npm run db:seed      # loads synthetic demo data + 5 demo users
npm run dev          # http://localhost:3000
```

Confirm: login page lists five identities; dashboard shows numbers.

## 1. Login and roles (2 min)

Log in as **Omar (Operator)** for the main flow. Show the role model briefly:

| Identity | Role | Sees / can do |
|---|---|---|
| Yasmine | Viewer (`operations_viewer`) | Read-only: dashboard, appointments, runs |
| Omar | Operator (`operations_operator`) | + create appointments, transition status, submit gate scans |
| Salma | Planner (`planner`) | + create planning & simulation runs |
| Karim | Supervisor (`supervisor`) | + approve/reject review items |
| Admin (Demo) | Administrator | highest rank |

"What to say (limitation #2): *This login is a demo stand-in — there are no
passwords, and production would use your real identity system.*"

Tip: log in as Yasmine for 10 seconds to show the UI hides actions the role
cannot perform — then switch back to Omar. Enforcement is server-side; the UI
only hides buttons.

## 2. Appointment lifecycle — TAS (3 min)

1. `/appointments` — five seeded synthetic appointments in mixed statuses.
2. Click **New appointment** — create one: plate `CAS-2026-X`, container
   `TCLU2026601`, a time ~2 h out. Show the UTC-Z validation.
3. Open it; click **Confirm** (transition `requested → confirmed`).
4. "What to say (limitation #1): *Every record here is generated for the
   demo — plates, containers, times. There is no real port data in this
   system.*"
5. If you double-submit: "What to say (limitation #4): *Retries are safe —
   the database enforces idempotency, so a duplicate submission can't create
   a duplicate appointment.*"

## 3. Gate scan — GateWatch (3 min, SIMULATED)

1. `/gate` — select the confirmed appointment.
2. Submit a scan with plate/container **exactly matching** the appointment and
   confidence 90 → **auto-accept**; the appointment moves to `checked-in`.
3. Submit again with a wrong container or confidence 30 → **human-review**;
   note the reason text.
4. "What to say: *This is a simulated scan — nobody is photographing a real
   truck. The verification logic is real: reads that don't match, or low or
   missing confidence, never auto-accept; they go to a human.*"
5. `/gate/reviews` — log in as **Karim (Supervisor)**; approve one item, reject
   another. Point at the audit log semantics: every decision records who and
   when.
6. "What to say (limitation #3): *The scan can't smuggle in a fake
   appointment — the server loads the appointment from its own database by ID
   and ignores anything the client sends about it.*"

## 4. Planning — BerthWise (3 min, proven-optimal vs heuristic)

1. Log in as **Salma (Planner)**; `/planning` → New plan.
2. Use a small scenario (≤ 8 vessels) with solver **exact** → result page shows
   the plan with a "proven optimal" indicator.
3. Run the same scenario with **annealing** → point at the optimality banner:
   heuristic result, not guaranteed optimal.
4. "What to say (limitation #5): *The exact solver proves optimality but only
   handles up to 8 vessels; the fast solvers are heuristics and the screen
   labels them as such. The heavy research solver is deliberately left out of
   the interactive demo.*"
5. (Optional) Add 9+ vessels with solver `exact` — it refuses cleanly.

## 5. Simulation — PortTwin (2 min, UNCALIBRATED)

1. `/simulate` → run a preset scenario (default seed 42, 100 replications).
2. Result page: KPI cards each tagged **simulated** or **assumed** — never
   "measured".
3. `/simulate/compare` — pick two runs side by side.
4. "What to say (limitation #6): *This simulator has never seen real port
   data — the numbers illustrate the model's mechanics, not the port. Before
   any decision use, it must be calibrated against observed operations.*"

## 6. Dashboard and audit (1 min)

1. `/` — metrics are computed from the demo database; create/scan activity
   from the demo moves the numbers.
2. Close with the audit trail: "What to say: *Every action in this demo —
   login, create, transition, scan, review decision, plan, simulation — is
   recorded in an append-only audit log.*"

## 7. Wrap-up line (30 s)

"*This is a working prototype of the platform's mechanics — appointments,
verification, planning, simulation, audit — on synthetic data. The code is
structured so the verified business logic from our four research modules can
drop in unchanged, and the six documented limitations are the roadmap to a
production system.*"

## Timing cheat-sheet

| # | Section | Min |
|---|---|---|
| 1 | Login & roles | 2 |
| 2 | Appointments | 3 |
| 3 | Gate scan (simulated) | 3 |
| 4 | Planning (optimal vs heuristic) | 3 |
| 5 | Simulation (uncalibrated) | 2 |
| 6 | Dashboard & audit | 1 |
| 7 | Wrap-up | 0.5 |
| | **Total** | **~15** |

If time runs short: cut section 5 first (the compare view), then the 9-vessel
refusal in section 4. Never cut the honesty lines — they are the demo.
