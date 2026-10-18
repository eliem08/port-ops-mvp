/**
 * Phase C — append-only audit trail for scenario runs.
 *
 * Answers "which run produced this decision": every completed scenario
 * run (and every cache hit serving a prior run) appends an `AuditEvent`
 * carrying the scenario id, the canonical input hash, the seed, the
 * actor, and a KPI summary. Approvals append a separate event type.
 *
 * Storage is an in-memory append-only log, explicitly labeled
 * DEMO-ONLY: it does not survive restarts and is not tamper-evident.
 * A production deployment replaces `AuditStore` with a durable,
 * write-once backend — the event shape and append-only API stay the
 * same.
 */

export type AuditEventType =
  | "scenario.run.completed"
  | "scenario.run.cache-hit"
  | "scenario.output.approved";

/** KPI summary attached to each run event (units in field names). */
export interface AuditKpiSummary {
  throughputTrucksPerHour: number;
  meanWaitMin: number;
  p95WaitMin: number;
  utilizationGatePct: number;
}

export interface AuditEvent {
  /** Monotonic id within this store instance (dev-labeled, not a UUID). */
  eventId: number;
  eventType: AuditEventType;
  scenarioId: string;
  /** Canonical input hash — joins a run to its exact input. */
  inputHash: string;
  /** Base seed of the baseSeed+replication scheme. null when the event is not a run (e.g. an approval). */
  seed: number | null;
  /** Who requested the run / approval ("anonymous" when unknown). */
  actor: string;
  /** ISO 8601 UTC timestamp. */
  atUtc: string;
  kpiSummary: AuditKpiSummary;
  /** Present on cache hits: the key that matched. */
  idempotencyKey?: string;
  /** Present on approvals: who approved and with what role. */
  approvedBy?: string;
  /** Always true for this implementation: marks the dev-grade backend. */
  devOnly: true;
}

/**
 * Append-only audit store. `record` freezes the event before storing;
 * `events()` returns a copy so callers cannot mutate history.
 */
export class AuditStore {
  private log: AuditEvent[] = [];
  private nextId = 1;

  record(event: Omit<AuditEvent, "eventId" | "devOnly">): AuditEvent {
    const full: AuditEvent = Object.freeze({
      ...event,
      eventId: this.nextId++,
      devOnly: true,
    });
    this.log.push(full);
    return full;
  }

  /** All events, oldest first. Returns a copy — the log is append-only. */
  events(): AuditEvent[] {
    return [...this.log];
  }

  /** Events for one input hash — the "which run produced this" query. */
  eventsForInput(inputHash: string): AuditEvent[] {
    return this.log.filter((e) => e.inputHash === inputHash);
  }

  /** Test/dev escape hatch. Labeled DEMO-ONLY with the rest of the store. */
  clear(): void {
    this.log = [];
    this.nextId = 1;
  }
}

/** Process-wide audit store (DEMO-ONLY in-memory backend). */
export const auditStore = new AuditStore();
