// Ships the audit trail to an external collector (SIEM, log pipeline) over
// HTTPS webhooks: AUDIT_WEBHOOK_URL (+ optional AUDIT_WEBHOOK_TOKEN bearer).
//
// Design: tails audit_events by rowid with a cursor persisted in `settings`,
// so EVERY audit row is shipped no matter which code path wrote it, delivery
// is at-least-once (the cursor only advances after a 2xx), and a restart or
// collector outage resumes where it stopped. Events are sent as
// { events: [...] } batches of up to 200.

import type { DatabaseSync } from "node:sqlite";

const CURSOR_KEY = "audit.forwarder.cursor";
const BATCH = 200;

export interface ForwarderConfig {
  url: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

function readCursor(db: DatabaseSync): number {
  const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(CURSOR_KEY) as { value_json: string } | undefined;
  return row ? Number(JSON.parse(row.value_json)) || 0 : 0;
}

function writeCursor(db: DatabaseSync, rowid: number): void {
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_by) VALUES (?, ?, 'system:audit-forwarder')
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`
  ).run(CURSOR_KEY, JSON.stringify(rowid));
}

/** Sends the next batch. Returns how many events were delivered (0 = idle). */
export async function forwardAuditBatch(db: DatabaseSync, cfg: ForwarderConfig): Promise<number> {
  const cursor = readCursor(db);
  const rows = db
    .prepare(
      `SELECT rowid AS seq, id, created_at, actor_id, action, entity, entity_id, detail_json
       FROM audit_events WHERE rowid > ? ORDER BY rowid LIMIT ?`
    )
    .all(cursor, BATCH) as Array<{
    seq: number;
    id: string;
    created_at: string;
    actor_id: string;
    action: string;
    entity: string;
    entity_id: string;
    detail_json: string;
  }>;
  if (rows.length === 0) return 0;

  const events = rows.map((r) => {
    let detail: unknown = {};
    try {
      detail = JSON.parse(r.detail_json);
    } catch {
      detail = { raw: r.detail_json };
    }
    return {
      id: r.id,
      seq: r.seq,
      timestamp: r.created_at,
      actor: r.actor_id,
      action: r.action,
      entity: r.entity,
      entityId: r.entity_id,
      detail,
      source: process.env.APP_NAME || "port-operations-intelligence",
    };
  });
  const res = await (cfg.fetchImpl ?? fetch)(cfg.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
    },
    body: JSON.stringify({ events }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`audit webhook responded ${res.status}`);
  writeCursor(db, rows[rows.length - 1].seq);
  return rows.length;
}

let timer: NodeJS.Timeout | null = null;

/** Starts the background forwarder (no-op without AUDIT_WEBHOOK_URL). */
export function startAuditForwarder(getDb: () => DatabaseSync): void {
  const url = process.env.AUDIT_WEBHOOK_URL;
  if (!url || timer) return;
  let busy = false;
  let failures = 0;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      // Drain the backlog, then idle until the next tick.
      while ((await forwardAuditBatch(getDb(), { url, token: process.env.AUDIT_WEBHOOK_TOKEN })) === BATCH) {
        /* keep draining */
      }
      failures = 0;
    } catch (err) {
      failures++;
      if (failures === 1 || failures % 60 === 0) {
        console.error(JSON.stringify({ level: "error", msg: "audit forwarding failed", failures, error: String(err) }));
      }
    } finally {
      busy = false;
    }
  }, 5_000);
  timer.unref();
}
