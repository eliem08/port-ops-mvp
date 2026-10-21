// Applies pending migrations in order, each in its own transaction, recording
// the version in schema_migrations. Shared by `npm run db:migrate` and the
// server's start-up (AUTO_MIGRATE), so containers need no extra tooling.

import type { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations";

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export function appliedVersions(db: DatabaseSync): Set<number> {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));"
  );
  return new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version)
  );
}

export function runMigrations(db: DatabaseSync): { applied: number[]; current: number } {
  const done = appliedVersions(db);
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(m.version);
      db.exec("COMMIT");
      applied.push(m.version);
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.version} failed: ${(e as Error).message}`);
    }
  }
  return { applied, current: LATEST_SCHEMA_VERSION };
}

/** Highest applied version (0 for an empty database). */
export function schemaVersion(db: DatabaseSync): number {
  const v = [...appliedVersions(db)];
  return v.length ? Math.max(...v) : 0;
}
