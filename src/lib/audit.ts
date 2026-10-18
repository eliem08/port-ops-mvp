// Append-only audit log. No UPDATE or DELETE queries exist for audit_events
// anywhere in this codebase — by convention and by code review.
import { getDb } from "./db/client";
import { randomUUID } from "node:crypto";
import type { AuditAction } from "@/contracts";

export function audit(
  actorId: string,
  action: AuditAction,
  entity: string,
  entityId: string,
  detail: Record<string, string | number | boolean | null> = {}
): void {
  const db = getDb();
  // Scalar-only detail; never log PII, request bodies, or secrets.
  db.prepare(
    `INSERT INTO audit_events (id, actor_id, action, entity, entity_id, detail_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), actorId, action, entity, entityId, JSON.stringify(detail));
}
