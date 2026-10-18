/**
 * src/lib/tas-adapter.ts
 *
 * TAS → GateWatch appointment adapter (Phase C integration seam).
 *
 * This is the ONE thin, tested integration slice between the two repos.
 * There is no shared backend and no monorepo: TAS is the source of truth
 * for the appointment contract (lib/contracts/appointment.ts in the TAS
 * repo, APPOINTMENT_CONTRACT_VERSION = "1.0.0"), and GateWatch keeps a
 * DELIBERATELY DUPLICATED minimal shape of it here (src/lib/contracts.ts),
 * pinned by TAS_APPOINTMENT_CONTRACT_VERSION_EXPECTED = "1.0.0". This file
 * reconciles the two: it validates an incoming TAS-shaped wire payload
 * with zod (version pin first, then the full contract shape), and maps it
 * onto the minimal AppointmentRef that verifyGateEventAgainstAppointment
 * consults. It composes adapter + verifier so one call yields a final
 * decision + reason codes from a scanned gate event and a raw TAS payload.
 *
 * Wire envelope: { contractVersion: "<semver>", appointment: { ...TAS
 * AppointmentContract... } }. The envelope is the shape a TAS booking API
 * response must emit (TAS's own contract object has no version field —
 * the version constant lives next to the contract in TAS's module, so the
 * envelope carries it on the wire). Both functions below NEVER throw and
 * NEVER coerce: unknown payloads return typed issues instead.
 *
 * ------------------------------------------------------------------ *
 * CROSS-SYSTEM TRUST ASSUMPTION (read before wiring this to a network):
 *
 * This adapter validates SHAPE, not provenance. A well-formed payload is
 * not a trustworthy payload: nothing here authenticates the sender,
 * verifies a signature, checks freshness, or authorizes the caller. In
 * production, the TAS appointment MUST arrive over an authenticated
 * channel (TLS + service identity), and the fetch MUST be authorized by
 * the real AuthProvider from src/lib/auth.ts (NOT the DevMockAuthProvider)
 * before rawAppointment ever reaches this adapter. A malicious or stale
 * payload that happens to be well-formed will verify — that is the fetch
 * layer's problem to prevent, not the adapter's.
 *
 * Also note: a "cancelled" status in the payload denies the scan only
 * because the payload says so. Payload replay (an old "confirmed" copy
 * reused after cancellation) is a real attack on this seam and must be
 * closed by the authenticated, fresh fetch — see future work below.
 *
 * ------------------------------------------------------------------ *
 * FUTURE WORK for a production seam:
 *
 * 1. Real TAS booking API emitting versioned { contractVersion,
 *    appointment } envelopes (documented against
 *    APPOINTMENT_CONTRACT_VERSION in the TAS repo).
 * 2. Server-side authorized fetch: an API route that calls
 *    verifyScannedAgainstTasAppointment only after AuthProvider
 *    authorizes the appointment lookup; raw payloads never cross the
 *    browser/server boundary unauthenticated.
 * 3. Freshness: the fetch must be per-scan (no cached payloads), and
 *    TAS-side cancellation must propagate before the next scan is
 *    verified (the adapter cannot detect replay).
 * 4. Automated reconciliation: a CI job that fails when either
 *    APPOINTMENT_CONTRACT_VERSION (TAS) or
 *    TAS_APPOINTMENT_CONTRACT_VERSION_EXPECTED (GateWatch) moves without
 *    the other — this file's duplicated shape is pinned to 1.0.0.
 * 5. Slot-window leeway/override policy owned by TAS (currently the
 *    manual-review-on-outside-window behavior is inherited from
 *    verify.ts; production should let TAS declare early/late arrival
 *    policy explicitly).
 */

import { z } from 'zod';
import {
  TAS_APPOINTMENT_CONTRACT_VERSION_EXPECTED,
  TasAppointmentStatusSchema,
  UtcDatetimeSchema,
  AppointmentRefSchema,
  type AppointmentRef,
  type VerificationDecision,
} from './contracts';
import {
  REASON_CODES,
  verifyGateEventAgainstAppointment,
  type ScanInput,
} from './verify';
import { checkDigitFor, normalizeContainer } from './iso6346';

/** One structured, machine-readable adapter issue (never a raw throw). */
export interface TasAdapterIssue {
  path: string;
  code: string;
  message: string;
}

export type TasAdapterResult =
  | { ok: true; ref: AppointmentRef }
  | { ok: false; issues: TasAdapterIssue[] };

function toIssues(error: z.ZodError): TasAdapterIssue[] {
  return error.issues.map((i) => ({
    path: i.path.map(String).join('.') || '(root)',
    code: String(i.code),
    message: i.message,
  }));
}

/**
 * The TAS AppointmentContract, duplicated verbatim in structure and
 * constraints (TAS is the source of truth —
 * lib/contracts/appointment.ts in the TAS repo). The one deliberate
 * adaptation: ISO 6346 validation reuses GateWatch's own check-digit
 * helper instead of copying TAS's letter table, but the acceptance rule
 * is identical — owner code + [UJZ] category + 7 digits, check digit
 * verified. This schema is pinned to
 * TAS_APPOINTMENT_CONTRACT_VERSION_EXPECTED: if TAS's contract moves,
 * this file is the reconciliation point.
 */
const TasAppointmentSchema = z
  .object({
    /** Stable id: "appt_" + ulid/uuid, server-assigned at creation. */
    id: z.string().regex(/^appt_[A-Za-z0-9_-]{8,64}$/, {
      message: 'id must look like appt_<ulid|uuid>',
    }),
    status: TasAppointmentStatusSchema,
    truck: z
      .object({
        plate: z.string().min(1).max(32),
        carrier: z.string().min(1).max(120),
      })
      .strict(),
    container: z
      .object({
        number: z
          .string()
          .regex(/^[A-Z]{3}[UJZ][0-9]{7}$/, {
            message:
              'must match ISO 6346 (3 owner letters + U/J/Z + 7 digits)',
          })
          .refine((n) => {
            const normalized = normalizeContainer(n);
            const expected = checkDigitFor(normalized.slice(0, 10));
            return expected === parseInt(normalized.slice(10), 10);
          }, { message: 'ISO 6346 check digit is invalid' }),
        type: z.string().min(1).max(32),
      })
      .strict(),
    slot: z
      .object({ startUtc: UtcDatetimeSchema, endUtc: UtcDatetimeSchema })
      .refine((s) => Date.parse(s.endUtc) > Date.parse(s.startUtc), {
        message: 'slot.endUtc must be after slot.startUtc',
      })
      .strict(),
    terminal: z.string().min(1).max(16),
    gate: z.string().min(1).max(16),
    createdAtUtc: UtcDatetimeSchema,
    updatedAtUtc: UtcDatetimeSchema,
  })
  .strict();

/** Wire envelope: version stamp + the appointment document. */
export const TasAppointmentPayloadSchema = z
  .object({
    contractVersion: z.string(),
    appointment: TasAppointmentSchema,
  })
  .strict();

/**
 * Field mapping from a TAS AppointmentContract document to GateWatch's
 * minimal AppointmentRef (documented here for both sides' tests):
 *
 *   appointment.id              → ref.appointmentId
 *   appointment.status          → ref.status
 *   appointment.container.number→ ref.containerNumber
 *   appointment.truck.plate     → ref.plate
 *   appointment.slot.startUtc   → ref.slotStartUtc
 *   appointment.slot.endUtc     → ref.slotEndUtc
 *   appointment.gate            → ref.gate
 */
export function appointmentContractToRef(
  raw: unknown,
): TasAdapterResult {
  // 1. The payload must at least carry a contractVersion string.
  const envelope = z
    .object({ contractVersion: z.string() })
    .loose()
    .safeParse(raw);
  if (!envelope.success) {
    return { ok: false, issues: toIssues(envelope.error) };
  }

  // 2. Version pin check — BEFORE the shape check, so a future contract
  //    version produces a clean mismatch error (naming expected vs found)
  //    instead of a pile of shape issues from a format we don't know.
  const found = envelope.data.contractVersion;
  if (found !== TAS_APPOINTMENT_CONTRACT_VERSION_EXPECTED) {
    return {
      ok: false,
      issues: [
        {
          path: 'contractVersion',
          code: 'version_mismatch',
          message:
            `TAS appointment contractVersion mismatch: expected ` +
            `"${TAS_APPOINTMENT_CONTRACT_VERSION_EXPECTED}", found "${found}". ` +
            `Reconcile src/lib/tas-adapter.ts before accepting this payload.`,
        },
      ],
    };
  }

  // 3. Full contract-shape validation (the duplication-with-version
  //    doctrine: this must match TAS's AppointmentContract exactly).
  const payload = TasAppointmentPayloadSchema.safeParse(raw);
  if (!payload.success) {
    return { ok: false, issues: toIssues(payload.error) };
  }

  // 4. Map onto the minimal reference shape. No coercion anywhere — the
  //    validated source already satisfies every AppointmentRef constraint.
  const a = payload.data.appointment;
  const ref: AppointmentRef = {
    appointmentId: a.id,
    status: a.status,
    containerNumber: a.container.number,
    plate: a.truck.plate,
    slotStartUtc: a.slot.startUtc,
    slotEndUtc: a.slot.endUtc,
    gate: a.gate,
  };
  const checked = AppointmentRefSchema.safeParse(ref);
  if (!checked.success) {
    // Unreachable given the validated source — but the adapter never
    // throws, so a defensive issues-return stays.
    return { ok: false, issues: toIssues(checked.error) };
  }
  return { ok: true, ref: checked.data };
}

export interface TasVerificationResult extends VerificationDecision {
  /** Present only when the TAS payload itself failed validation. */
  adapterIssues?: TasAdapterIssue[];
}

/**
 * One-call seam: validate a raw TAS appointment payload, then verify a
 * scanned gate event against it.
 *
 * Status policy (encoded from TAS's booking state machine):
 * - confirmed / checked-in  → eligible for authorization
 * - cancelled / completed / no-show → denied
 *   (appointment-cancelled / appointment-not-active)
 * - requested (never confirmed)     → manual-review
 *   (appointment-unconfirmed)
 * - scan outside [slotStartUtc, slotEndUtc] → manual-review
 *   (outside-slot-window), inherited from verify.ts — no second policy.
 *
 * An invalid TAS payload NEVER authorizes: it degrades to manual-review
 * with reason code appointment-ref-invalid and the adapter issues
 * attached for the operator/audit trail.
 */
export function verifyScannedAgainstTasAppointment(
  scanned: ScanInput,
  rawAppointment: unknown,
): TasVerificationResult {
  const adapted = appointmentContractToRef(rawAppointment);
  if (!adapted.ok) {
    return {
      decision: 'manual-review',
      reasonCodes: [REASON_CODES.APPOINTMENT_REF_INVALID],
      adapterIssues: adapted.issues,
    };
  }
  return verifyGateEventAgainstAppointment(scanned, adapted.ref);
}
