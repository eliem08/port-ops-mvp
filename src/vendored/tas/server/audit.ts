/**
 * lib/server/audit.ts
 *
 * DEV-ONLY append-only audit trail (in-memory). Records booking
 * creates / cancels / replans and recommendation approvals.
 *
 * Append-only means: the store exposes record() and a read-only
 * snapshot of events — there is deliberately NO update() or delete()
 * API, so history cannot be rewritten through this module.
 * A production implementation must persist events durably and be
 * tamper-evident; this one is lost on process restart.
 */

export interface AuditEvent {
  /** Stable id: audit_<ulid>. */
  id: string;
  /** Monotonic sequence number (1, 2, 3, …) — gapless per process. */
  seq: number;
  /** ISO 8601 UTC timestamp of recording. */
  tsUtc: string;
  /** Who performed the action (user id or service name). */
  actor: string;
  /** What happened, e.g. "booking.created", "booking.cancelled". */
  action: string;
  /** Entity kind, e.g. "appointment", "recommendation". */
  entityType: string;
  /** Id of the affected entity. */
  entityId: string;
  /** State before the change (null for creates). */
  before: unknown;
  /** State after the change. */
  after: unknown;
  /** Human reason supplied by the actor, if any. */
  reason?: string;
}

/** Input accepted by AuditLog.record() — id/seq/ts are server-assigned. */
export type AuditEventInput = Omit<AuditEvent, "id" | "seq" | "tsUtc">;

const ULID_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function newAuditId(nowMs: number): string {
  let n = nowMs;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = ULID_CHARS[n % 32] + time;
    n = Math.floor(n / 32);
  }
  let rand = "";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 16; i++) rand += ULID_CHARS[bytes[i] % 32];
  return `audit_${time}${rand}`;
}

export class AuditLog {
  private events: AuditEvent[] = [];
  private nextSeq = 1;

  /** Append one event; assigns id, seq and tsUtc. Returns the event. */
  record(input: AuditEventInput): AuditEvent {
    const now = new Date();
    const event: AuditEvent = {
      ...input,
      id: newAuditId(now.getTime()),
      seq: this.nextSeq++,
      tsUtc: now.toISOString(),
    };
    this.events.push(event);
    return event;
  }

  /**
   * Read-only snapshot: deep-cloned, frozen events in seq order.
   * There is no API to mutate or delete an event once recorded.
   */
  list(): ReadonlyArray<Readonly<AuditEvent>> {
    return Object.freeze(
      this.events.map((e) =>
        Object.freeze({
          ...e,
          before: e.before === undefined ? undefined : JSON.parse(JSON.stringify(e.before)),
          after: e.after === undefined ? undefined : JSON.parse(JSON.stringify(e.after)),
        }),
      ),
    );
  }

  /** Events for one entity, in seq order. */
  forEntity(entityType: string, entityId: string): AuditEvent[] {
    return this.events
      .filter((e) => e.entityType === entityType && e.entityId === entityId)
      .map((e) => ({ ...e }));
  }

  get count(): number {
    return this.events.length;
  }

  /** Test/reset hook only — production logs would never expose this. */
  clear(): void {
    this.events = [];
    this.nextSeq = 1;
  }
}

/** Process-wide audit log singleton (dev-only, in-memory). */
export const auditLog = new AuditLog();
