# Port Operations Intelligence Platform — MVP (Demo)

**⚠️ DEMO SYSTEM — SYNTHETIC DATA ONLY. Not a production system. Not affiliated with ANP or Marsa Maroc.**

A unified demonstration application integrating four Casablanca port-operations modules:
- **TAS** — Truck appointment coordination (vendored from `eliem08/tas-casablanca`)
- **GateWatch** — Gate verification (vendored from `eliem08/gatewatch`)
- **BerthWise** — Berth planning (vendored from `eliem08/berthwise`)
- **PortTwin** — Operations simulation (vendored from `eliem08/porttwin`)

## Quick start

```bash
npm install
npm run db:migrate   # create SQLite schema
npm run db:seed      # load synthetic demo data
npm run dev          # start on http://localhost:3000
```

Open http://localhost:3000 → you'll be redirected to `/login`. Pick any demo identity (e.g. "Omar (Operator)").

## Demo scenario

1. **Dashboard** (`/`) — real metrics from the demo database.
2. **Appointments** (`/appointments`) — view seeded appointments; create a new one (validated, idempotent).
3. **GateWatch** (`/gate`) — select the appointment, submit a **simulated** scan, see the verification outcome (auto-accept / human-review / scan-failed).
4. **Reviews** (`/gate/reviews`) — supervisor approves/rejects human-review items.
5. Refresh the browser — all records persist (SQLite).
6. **Planning** (`/planning`) — submit vessel/berth scenarios; proven-optimal vs heuristic labeling.
7. **Simulator** (`/simulate`) — run scenarios, compare side-by-side (uncalibrated model — illustrative only).

## Architecture

```
Unified Next.js UI
  → API routes (server-side auth, Zod validation)
    → Vendored business logic (pure functions, do-not-edit)
      → SQLite (atomic persistence, audit trail)
```

Business logic is vendored verbatim from the four source repos — see [VENDORED.md](VENDORED.md). Fixes go upstream first.

## Key security properties

- **GateWatch trusted boundary**: verification loads the appointment from the platform DB by ID server-side. Client-supplied appointment data is never trusted (fixes the documented replay risk by construction).
- **Atomic idempotency**: appointment creation uses SQLite UNIQUE constraints + transactions (fixes the documented non-atomicity).
- **Demo auth**: role-based, server-enforced, fail-closed. Loudly labeled DEMO — not a production identity provider.
- **Fail-closed verification**: NaN/out-of-range confidence never auto-accepts (regression-tested).

## Limitations (not concealed)

1. No real port operational data — all records synthetic.
2. Demo auth only — no production identity provider (8 h session expiry,
   in-memory rate limits: login 10/min/IP, scan submissions 60/min/user).
3. TAS concurrent idempotency is atomic via SQLite (fixed in this platform).
4. BerthWise exact solver is capped at 8 vessels (`EXACT_MAX_VESSELS`);
   larger instances fall back to labeled greedy; heuristic results are
   explicitly non-optimal (`provenOptimal` gating). ALNS is vendored but
   deliberately excluded from interactive paths. Planning UI and API
   (`/planning`, `/api/planning/runs`) are live in this slice.
5. PortTwin model is uncalibrated — outputs are illustrative, never measured
   facts; simulation UI and API (`/simulate`, `/api/simulate/*`) are live in
   this slice.
6. Dependency audits — see source repos (upstream advisories tracked via Dependabot).

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start dev server |
| `npm run build` | Production build |
| `npm run typecheck` | TypeScript check |
| `npm run test` | Vitest suite |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` | Load synthetic demo data |
| `npm run db:reset` | Wipe demo DB (requires ALLOW_DB_RESET=1, refuses in production) |
