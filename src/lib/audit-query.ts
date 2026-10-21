// Read side of the append-only audit trail: filtered, paginated queries for
// the audit viewer and CSV export for auditors / SIEM back-fills.

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { toCsv } from "./csv";

export const AuditFilter = z.object({
  action: z.string().max(64).optional(),
  actor: z.string().max(128).optional(),
  entity: z.string().max(64).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export type AuditFilter = z.infer<typeof AuditFilter>;

export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_EXPORT_MAX = 50_000;

export interface AuditRow {
  id: string;
  createdAt: string;
  actorId: string;
  actorLabel: string | null;
  action: string;
  entity: string;
  entityId: string;
  detail: string;
}

function where(f: AuditFilter): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (f.action) {
    clauses.push("e.action = ?");
    params.push(f.action);
  }
  if (f.actor) {
    clauses.push("(e.actor_id = ? OR u.email = ? OR u.label LIKE ?)");
    params.push(f.actor, f.actor.toLowerCase(), `%${f.actor}%`);
  }
  if (f.entity) {
    clauses.push("e.entity = ?");
    params.push(f.entity);
  }
  // created_at holds either "YYYY-MM-DD HH:MM:SS" (SQLite default) or ISO;
  // comparing on the first 10 characters is format-agnostic.
  if (f.from) {
    clauses.push("substr(e.created_at, 1, 10) >= ?");
    params.push(f.from.slice(0, 10));
  }
  if (f.to) {
    clauses.push("substr(e.created_at, 1, 10) <= ?");
    params.push(f.to.slice(0, 10));
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

const SELECT = `SELECT e.id, e.created_at, e.actor_id, u.label AS actor_label, e.action, e.entity, e.entity_id, e.detail_json
  FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id`;

type Raw = {
  id: string;
  created_at: string;
  actor_id: string;
  actor_label: string | null;
  action: string;
  entity: string;
  entity_id: string;
  detail_json: string;
};

const toRow = (r: Raw): AuditRow => ({
  id: r.id,
  createdAt: r.created_at,
  actorId: r.actor_id,
  actorLabel: r.actor_label,
  action: r.action,
  entity: r.entity,
  entityId: r.entity_id,
  detail: r.detail_json,
});

export function queryAudit(db: DatabaseSync, f: AuditFilter): { rows: AuditRow[]; total: number; pages: number } {
  const w = where(f);
  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id ${w.sql}`).get(...w.params) as { n: number }).n
  );
  const rows = (
    db
      .prepare(`${SELECT} ${w.sql} ORDER BY e.created_at DESC, e.rowid DESC LIMIT ? OFFSET ?`)
      .all(...w.params, AUDIT_PAGE_SIZE, (f.page - 1) * AUDIT_PAGE_SIZE) as Raw[]
  ).map(toRow);
  return { rows, total, pages: Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE)) };
}

export function exportAuditCsv(db: DatabaseSync, f: AuditFilter): { csv: string; count: number } {
  const w = where(f);
  const rows = (
    db.prepare(`${SELECT} ${w.sql} ORDER BY e.created_at ASC, e.rowid ASC LIMIT ?`).all(...w.params, AUDIT_EXPORT_MAX) as Raw[]
  ).map(toRow);
  const csv = toCsv(
    ["id", "created_at", "actor_id", "actor", "action", "entity", "entity_id", "detail_json"],
    rows.map((r) => [r.id, r.createdAt, r.actorId, r.actorLabel, r.action, r.entity, r.entityId, r.detail])
  );
  return { csv, count: rows.length };
}

export function distinctAuditActions(db: DatabaseSync): string[] {
  return (db.prepare("SELECT DISTINCT action FROM audit_events ORDER BY action").all() as Array<{ action: string }>).map((r) => r.action);
}
