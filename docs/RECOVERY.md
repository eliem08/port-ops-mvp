# Recovery & Troubleshooting — Port Operations Intelligence Platform

Demo database = local SQLite file (`dev.db` by default, `file:./dev.db`).
There is no server to restart and no cloud state to reconcile.

## 1. Reset and re-seed

| Command | What it does |
|---|---|
| `npm run db:migrate` | Creates the schema (idempotent; tracks `schema_migrations`). Run once after `npm install`. |
| `npm run db:seed` | Inserts 5 demo users + 5 synthetic appointments (+ audit events). Safe to re-run (`INSERT OR IGNORE`). |
| `npm run db:reset` | **Wipes the demo database.** Requires `ALLOW_DB_RESET=1` and **refuses in production** (`NODE_ENV=production`). After reset, run `db:migrate && db:seed`. |

Full fresh start:

```bash
ALLOW_DB_RESET=1 npm run db:reset
npm run db:migrate
npm run db:seed
npm run dev
```

Seeding note: appointments get randomized UUIDs, so seeded appointment URLs
change on every re-seed. Demo-driver names are tagged `[SYNTHETIC DEMO DATA]`.

## 2. Demo-only guards (why they exist)

- **`db:reset` refuses in production** (`src/lib/db/reset.ts`): exits with an
  error if `NODE_ENV=production`, and without `ALLOW_DB_RESET=1`. This is the
  only destructive script in the repo.
- **Scans are always simulated:** `gate_verification_events.simulated` is
  hard-coded to `1` at every insert site; `VerificationRecord.simulated` is a
  Zod `literal(true)`. There is no code path that records a "real" scan.
- **Permanent DEMO banner:** `src/app/layout.tsx` renders `DEMO — SYNTHETIC
  DATA` on every page; it cannot be removed by data or config.
- **`calibrated = 0` always** on `simulation_runs`; `proven_optimal = 1` only
  when the exact solver ran (see schema comments in
  `src/lib/db/migrations.ts`).
- **`.env.example` is explicit:** `DEMO_AUTH_SECRET` is labeled demo-only and
  must be a random 256-bit value from a secret manager in any real deployment.

## 3. Troubleshooting

### Port 3000 already in use

```bash
lsof -ti:3000 | xargs kill -9   # then npm run dev
```

### Database locked / WAL errors

`dev.db-wal` / `dev.db-shm` are SQLite's write-ahead files — normal. If the dev
server is killed mid-write and the DB reports locked:

1. Stop `next dev`.
2. Delete only the WAL sidecars (`dev.db-wal`, `dev.db-shm`) — SQLite replays
   or discards them on next open.
3. Restart `next dev`. If errors persist, do the full reset in §1.

Concurrent `next dev` instances against the same file will fight; run one.

### Migrations

`npm run db:migrate` is idempotent (`CREATE TABLE IF NOT EXISTS` + version
table). If you need to start truly clean, use `db:reset` (see guard above),
never hand-edit `dev.db`.

### Node version

Requires a Node with `node:sqlite` (Node ≥ 22). Check `node -v`. Older Node
fails at import time with `Cannot find module 'node:sqlite'`.

### `.env` problems

Copy `.env.example` → `.env` and set:

```
DATABASE_URL=file:./dev.db
DEMO_AUTH_SECRET=<random-64-hex-chars>
```

- "Demo login required" on every page → cookie secret changed mid-session;
  log out and back in (sessions are stateless JWTs signed with the secret).
- The app falls back to a hard-coded default secret if `.env` is missing —
  fine for a local demo, **unacceptable** anywhere else.

### Tests

```bash
npm run test        # vitest — 90 tests pass across 6 files
npm run typecheck   # tsc --noEmit
```

Known issue: `src/app/api/appointments/appointments-routes.test.ts` is
untracked and does not load (references a non-existent
`@/test-utils/route-harness`; fails at collection with a hoisting error).
It contributes 0 tests; the 90 passing tests above exclude it.

Test-only: `src/test-utils/sqlite-shim.ts` provides a vitest shim for
`node:sqlite`; it is not part of the app.

## 4. Known quirks

- `.next/` build output is checked into the branch and drifts on every build
  (modified/deleted files). It is noise for review — ignore it; only
  `src/`, `docs/`, `VENDORED.md`, `README.md`, and config matter.
- README's "UI in next slice" note for BerthWise/PortTwin is stale on
  `feat/mvp-slice-1`: planning and simulation pages and API routes are live.
- The appointments scan server action (`src/lib/actions.ts`) derives the demo
  slot window as `scheduled_at ± 1 h` — a demo simplification, not scheduling
  data.
