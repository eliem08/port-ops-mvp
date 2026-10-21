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

// Migration 002 — production authentication.
// demo_users becomes users (existing rows and ids are preserved) and gains
// credentials, lockout, MFA and SSO columns. Sessions move server-side so
// they can be listed and revoked; the cookie JWT only carries the session id.
export const MIGRATION_002 = `
ALTER TABLE demo_users RENAME TO users;
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN password_hash TEXT;            -- scrypt, see src/lib/password.ts
ALTER TABLE users ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TEXT;             -- ISO UTC; NULL = not locked
ALTER TABLE users ADD COLUMN mfa_secret TEXT;               -- base32 TOTP secret
ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN password_changed_at TEXT;
ALTER TABLE users ADD COLUMN last_login_at TEXT;
ALTER TABLE users ADD COLUMN external_subject TEXT;         -- OIDC "iss|sub" for SSO users
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external ON users(external_subject) WHERE external_subject IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  auth_method TEXT NOT NULL,                  -- password | password+totp | oidc
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at TEXT NOT NULL,                   -- ISO UTC
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`;

// Migration 003 — governance and data intake.
// settings: administrator-controlled operating policy (e.g. human review).
// import_batches: one row per CSV import, with its validation report.
export const MIGRATION_003 = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                       -- appointments
  filename TEXT,
  row_count INTEGER NOT NULL,
  created_count INTEGER NOT NULL,
  skipped_count INTEGER NOT NULL,           -- duplicates (same external_ref)
  error_count INTEGER NOT NULL,
  report_json TEXT NOT NULL,                -- per-row errors (capped)
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events(action);
`;

export const MIGRATIONS = [
  { version: 1, sql: MIGRATION_001 },
  { version: 2, sql: MIGRATION_002 },
  { version: 3, sql: MIGRATION_003 },
];
