import { z } from "zod";
import { isoUtcString, planIdString } from "./shared";

/** Version of the AuditEvent wire contract. */
export const AUDIT_CONTRACT_VERSION = "1.0.0";

export const AuditEventTypeSchema = z.enum([
  "plan.generated",
  "plan.approved",
  "plan.superseded",
]);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

/**
 * AuditEvent — one immutable fact about a plan's lifecycle.
 *
 * Approvals and supersessions record the before/after plan ids, the approver
 * and the reason, so any plan's lineage can be reconstructed from the log
 * alone. The store (`src/lib/audit.ts`) is append-only: events are never
 * edited or deleted, only appended.
 */
export const AuditEventSchema = z.object({
  contractVersion: z.literal(AUDIT_CONTRACT_VERSION).default(AUDIT_CONTRACT_VERSION),
  eventId: z.string().min(1).max(64),
  type: AuditEventTypeSchema,
  /** The plan this event concerns. */
  planId: planIdString,
  /** For supersessions: the plan being replaced. */
  previousPlanId: planIdString.optional(),
  /** Human or service identity that caused the event. */
  actor: z.string().min(1).max(128),
  /** Role the actor held at the time (from the RBAC adapter). */
  role: z.string().min(1).max(32),
  /** Why the action was taken; required for approvals and supersessions. */
  reason: z.string().min(1).max(2000).optional(),
  createdAtUtc: isoUtcString,
});

export type AuditEvent = z.infer<typeof AuditEventSchema>;
