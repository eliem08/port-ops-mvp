// Prometheus metrics (text exposition format 0.0.4). Business gauges are
// computed from the database at scrape time — cheap COUNT queries on indexed
// columns — plus process health. Scraped from GET /api/metrics.

import type { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { schemaVersion } from "./db/run-migrations";

type Sample = { labels?: Record<string, string>; value: number };

function family(name: string, help: string, type: "gauge" | "counter", samples: Sample[]): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const s of samples) {
    const labels = s.labels
      ? `{${Object.entries(s.labels)
          .map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`)
          .join(",")}}`
      : "";
    lines.push(`${name}${labels} ${Number.isFinite(s.value) ? s.value : 0}`);
  }
  return lines.join("\n");
}

const count = (db: DatabaseSync, sql: string, ...params: string[]) =>
  Number((db.prepare(sql).get(...params) as { n: number }).n);

export function collectMetrics(db: DatabaseSync, dbFile?: string): string {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const nowIso = new Date().toISOString();
  const byStatus = db.prepare("SELECT status, COUNT(*) AS n FROM appointments GROUP BY status").all() as Array<{ status: string; n: number }>;
  const outcomes = db
    .prepare(
      "SELECT outcome, COUNT(*) AS n FROM gate_verification_events WHERE replace(created_at, ' ', 'T') >= ? GROUP BY outcome"
    )
    .all(since.slice(0, 19)) as Array<{ outcome: string; n: number }>;
  const mem = process.memoryUsage();
  let dbBytes = 0;
  try {
    if (dbFile) dbBytes = statSync(dbFile).size;
  } catch {
    // in-memory / unknown
  }

  return (
    [
      family("portops_appointments", "Truck appointments by status.", "gauge", byStatus.map((r) => ({ labels: { status: r.status }, value: Number(r.n) }))),
      family("portops_gate_verifications_24h", "Gate verifications in the last 24 hours by outcome.", "gauge",
        outcomes.map((r) => ({ labels: { outcome: r.outcome }, value: Number(r.n) }))),
      family("portops_reviews_pending", "Gate scans waiting for a supervisor decision.", "gauge", [
        { value: count(db, "SELECT COUNT(*) AS n FROM review_items WHERE status = 'pending'") },
      ]),
      family("portops_users", "User accounts by state.", "gauge", [
        { labels: { state: "active" }, value: count(db, "SELECT COUNT(*) AS n FROM users WHERE disabled = 0") },
        { labels: { state: "disabled" }, value: count(db, "SELECT COUNT(*) AS n FROM users WHERE disabled = 1") },
        { labels: { state: "locked" }, value: count(db, "SELECT COUNT(*) AS n FROM users WHERE locked_until > ?", nowIso) },
      ]),
      family("portops_sessions_active", "Active (unexpired, unrevoked) sessions.", "gauge", [
        { value: count(db, "SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ?", nowIso) },
      ]),
      family("portops_failed_logins_24h", "Failed sign-in attempts in the last 24 hours.", "gauge", [
        { value: count(db, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'auth.login_failed' AND replace(created_at, ' ', 'T') >= ?", since.slice(0, 19)) },
      ]),
      family("portops_audit_events", "Total audit events recorded.", "counter", [{ value: count(db, "SELECT COUNT(*) AS n FROM audit_events") }]),
      family("portops_schema_version", "Applied database schema version.", "gauge", [{ value: schemaVersion(db) }]),
      family("portops_database_bytes", "Size of the SQLite database file.", "gauge", [{ value: dbBytes }]),
      family("process_resident_memory_bytes", "Resident memory size in bytes.", "gauge", [{ value: mem.rss }]),
      family("process_heap_used_bytes", "V8 heap used in bytes.", "gauge", [{ value: mem.heapUsed }]),
      family("process_uptime_seconds", "Process uptime in seconds.", "gauge", [{ value: Math.round(process.uptime()) }]),
    ].join("\n") + "\n"
  );
}
