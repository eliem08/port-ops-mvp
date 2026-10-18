// Migration 001 — initial schema.
// SQLite via node:sqlite. Run with: npm run db:migrate

export const MIGRATION_001 = `
-- TAS appointments. Status uses the TAS six-status contract enum;
-- validated by Zod at the API boundary (SQLite has no native enum).
CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  truck_plate TEXT NOT NULL,
  container_no TEXT,
  driver_name TEXT,
  scheduled_at TEXT NOT NULL,          -- ISO 8601 UTC
  status TEXT NOT NULL,                -- contract enum
  created_by TEXT NOT NULL,            -- demo user id
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  idempotency_key TEXT UNIQUE          -- atomic check-and-create
);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
CREATE INDEX IF NOT EXISTS idx_appointments_scheduled ON appointments(scheduled_at);

-- GateWatch verification events. Scans are ALWAYS synthetic in the demo.
CREATE TABLE IF NOT EXISTS gate_verification_events (
  id TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL REFERENCES appointments(id),
  simulated INTEGER NOT NULL DEFAULT 1,
  plate_read TEXT,
  container_read TEXT,
  confidence REAL,                     -- 0-100; out-of-range/NaN must NEVER auto-accept
  outcome TEXT NOT NULL,               -- auto-accept | human-review | scan-failed
  reason TEXT NOT NULL,
  verified_by TEXT NOT NULL,           -- demo user id
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_verifications_appointment ON gate_verification_events(appointment_id);
CREATE INDEX IF NOT EXISTS idx_verifications_outcome ON gate_verification_events(outcome);

-- Human review queue
CREATE TABLE IF NOT EXISTS review_items (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES gate_verification_events(id),
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  decided_by TEXT,
  decided_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_review_status ON review_items(status);

-- BerthWise plans (UI in later slice; schema now)
CREATE TABLE IF NOT EXISTS berth_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  solver TEXT NOT NULL,
  proven_optimal INTEGER NOT NULL DEFAULT 0,  -- NEVER 1 unless solver proved it
  result_json TEXT NOT NULL,
  assumptions TEXT NOT NULL,                  -- JSON array
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(input_hash, solver)
);

-- PortTwin simulation runs (UI in later slice; schema now)
CREATE TABLE IF NOT EXISTS simulation_runs (
  id TEXT PRIMARY KEY,
  scenario_name TEXT NOT NULL,
  input_hash TEXT NOT NULL UNIQUE,
  seed INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  assumptions TEXT NOT NULL,                  -- JSON array
  calibrated INTEGER NOT NULL DEFAULT 0,      -- ALWAYS 0 until real data exists
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit trail: append-only. No UPDATE or DELETE permitted by convention;
-- enforced at the application layer (no UPDATE/DELETE queries exist).
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events(actor_id);

-- Demo identities. NOT production auth.
CREATE TABLE IF NOT EXISTS demo_users (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  role TEXT NOT NULL,  -- operations_viewer | operations_operator | planner | supervisor | administrator
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Idempotency keys: INSERT OR IGNORE gives atomic check-and-create.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export const MIGRATIONS = [{ version: 1, sql: MIGRATION_001 }];
