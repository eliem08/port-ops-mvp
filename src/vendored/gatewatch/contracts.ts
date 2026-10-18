/**
 * Versioned zod contracts for GateWatch gate-verification records.
 *
 * Phase C — "minimum necessary" doctrine: this is a client-side demo with
 * no server and no real database. These contracts exist so that every
 * ingestion boundary (scan ingestion, localStorage loads, review decisions)
 * validates data against a versioned schema instead of trusting it, and so
 * that corrupted records can be quarantined instead of crashing the app.
 *
 * DEMO-ONLY RECORDS. Everything these schemas validate still lives in the
 * visitor's browser (localStorage). A versioned contract is a format
 * discipline, not security infrastructure: production needs a server-side
 * store with an append-only audit trail (see the methodology page,
 * "What production needs").
 */

import { z } from 'zod';

/** Current version of the gate-verification event contract. */
export const GATE_EVENT_CONTRACT_VERSION = '1.0.0' as const;

/**
 * The MINIMAL appointment shape GateWatch needs from the truck-appointment
 * system (TAS). This shape is DELIBERATELY DUPLICATED here — it does not
 * import anything from TAS, because there is no shared backend and no
 * monorepo. TAS's contract (lib/contracts/appointment.ts, source of truth)
 * is reconciled against this shape by the integration worker in
 * src/lib/tas-adapter.ts; the version constant below is the pinned
 * expectation it must match. If TAS's contract moves, bump this file and
 * re-run the reconciliation instead of silently drifting.
 */
export const TAS_APPOINTMENT_CONTRACT_VERSION_EXPECTED = '1.0.0' as const;

/**
 * TAS's AppointmentStatus enum, duplicated verbatim from TAS's contract.
 * TAS is the source of truth — kept in sync by the reconciliation above.
 */
const TasAppointmentStatusSchema = z.enum([
  'requested',
  'confirmed',
  'checked-in',
  'completed',
  'cancelled',
  'no-show',
]);
export { TasAppointmentStatusSchema };
export type TasAppointmentStatus = z.infer<typeof TasAppointmentStatusSchema>;

/**
 * ISO 8601 UTC datetime ending in "Z", duplicated verbatim from TAS's
 * `UtcDatetime` (TAS is the source of truth for the wire format).
 */
export const UtcDatetimeSchema = z
  .string()
  .refine(
    (s) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(s) &&
      !Number.isNaN(Date.parse(s)),
    { message: "must be an ISO 8601 UTC datetime ending in 'Z'" },
  );

/**
 * Minimal appointment reference (duplicated minimal TAS shape — see above).
 * Only the fields GateWatch actually consults when verifying a scan.
 */
export const AppointmentRefSchema = z.object({
  appointmentId: z.string().min(1),
  status: TasAppointmentStatusSchema,
  containerNumber: z.string().min(1),
  plate: z.string().min(1),
  slotStartUtc: UtcDatetimeSchema,
  slotEndUtc: UtcDatetimeSchema,
  gate: z.string().min(1).max(16),
});

export type AppointmentRef = z.infer<typeof AppointmentRefSchema>;

/**
 * OCR confidences on the 0–100 scale (same scale as the review threshold).
 * `.finite()` is the Phase B NaN lesson carried forward: a non-finite
 * confidence must fail validation, never slip through as a number.
 */
const ConfidenceSchema = z.number().finite().min(0).max(100);

const AppointmentPointerSchema = z.object({
  appointmentId: z.string().min(1).optional(),
  contractVersion: z.string().optional(),
});

/**
 * Minimum OCR confidence (0–100) that a scan must reach before it can
 * participate in an authorization decision. Matches the operator's review
 * threshold: anything below goes to a human first.
 */
export const AUTH_CONFIDENCE_THRESHOLD = 70;

/**
 * A verified gate-crossing record. The refinement below enforces the core
 * Phase C safety rule: `decision: "authorized"` is REJECTED unless OCR
 * confidence thresholds are met AND an appointment reference exists. OCR
 * alone must never authorize a crossing.
 */
export const GateVerificationEventSchema = z
  .object({
    id: z.string().min(1),
    /** ISO 8601 UTC timestamp of the scan, e.g. 2026-10-17T12:00:00Z. */
    scannedAtUtc: z.iso.datetime(),
    gateId: z.string().min(1),
    direction: z.enum(['in', 'out']),
    vehicle: z.object({ plate: z.string().min(1) }),
    container: z.object({
      number: z.string().min(1),
      checkDigitValid: z.boolean(),
    }),
    ocr: z.object({
      containerConfidence: ConfidenceSchema,
      plateConfidence: ConfidenceSchema,
      engine: z.string().min(1),
    }),
    appointmentRef: AppointmentPointerSchema,
    decision: z.enum(['authorized', 'manual-review', 'denied']),
    decidedBy: z.string().min(1),
    reasonCodes: z.array(z.string()),
    idempotencyKey: z.string().min(1).optional(),
  })
  .superRefine((event, ctx) => {
    if (event.decision !== 'authorized') return;
    const lowConfidence =
      event.ocr.containerConfidence < AUTH_CONFIDENCE_THRESHOLD ||
      event.ocr.plateConfidence < AUTH_CONFIDENCE_THRESHOLD;
    if (lowConfidence) {
      ctx.addIssue({
        code: 'custom',
        message:
          'decision "authorized" requires OCR confidences at or above the review threshold (70). OCR alone must never authorize.',
      });
    }
    if (!event.appointmentRef.appointmentId) {
      ctx.addIssue({
        code: 'custom',
        message:
          'decision "authorized" requires an appointment reference. OCR alone must never authorize.',
      });
    }
  });

export type GateVerificationEvent = z.infer<typeof GateVerificationEventSchema>;

/** The wire shape GateWatch submits for verification before it is decided. */
export const GateScanSubmissionSchema = z.object({
  scannedAtUtc: z.iso.datetime(),
  gateId: z.string().min(1),
  direction: z.enum(['in', 'out']),
  plate: z.string().min(1),
  containerNumber: z.string().min(1),
  containerConfidence: ConfidenceSchema,
  plateConfidence: ConfidenceSchema,
  engine: z.string().min(1),
  appointmentId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
});

export type GateScanSubmission = z.infer<typeof GateScanSubmissionSchema>;

/** Result of verifying one scan against one appointment reference. */
export const VerificationDecisionSchema = z.object({
  decision: z.enum(['authorized', 'manual-review', 'denied']),
  reasonCodes: z.array(z.string()),
});

export type VerificationDecision = z.infer<typeof VerificationDecisionSchema>;

/* ------------------------------------------------------------------ *
 * Legacy on-load validation contracts.
 *
 * These mirror the pre-Phase-C shapes already persisted in users'
 * browsers (gate log, review queue, slot registry). They exist ONLY so
 * the localStorage ingestion boundary can validate-and-quarantine
 * instead of `JSON.parse`-and-trust. They are not versioned as an API;
 * new records should use GateVerificationEvent above.
 * ------------------------------------------------------------------ */

/** HH:MM 24h window label as used by the demo slot registry. */
const WindowLabelSchema = z.string().regex(/^\d{2}:\d{2}$/, 'expected HH:MM');

export const LegacyGateLogEntrySchema = z.object({
  id: z.string(),
  ts: z.number().finite(),
  image: z.string(),
  plate: z.string(),
  container: z.string(),
  isoValid: z.boolean(),
  result: z.string(),
  gate: z.number().optional(),
  processingMs: z.number().finite(),
  lane: z.number().nullable().optional(),
  reviewed: z.boolean().optional(),
  corrected: z.boolean().optional(),
});

export const LegacyReviewItemSchema = z.object({
  id: z.string(),
  batchId: z.string(),
  imageName: z.string(),
  imageUrl: z.string(),
  ocrPlate: z.string(),
  ocrContainer: z.string(),
  confidence: z.number().finite(),
  plate: z.string(),
  container: z.string(),
  status: z.enum(['pending', 'approved', 'corrected']),
  decidedAt: z.number().finite().nullable(),
});

export const LegacySlotSchema = z.object({
  id: z.string(),
  plate: z.string(),
  container: z.string(),
  company: z.string(),
  line: z.string(),
  gate: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  windowStart: WindowLabelSchema,
  windowEnd: WindowLabelSchema,
});

export type LegacySlot = z.infer<typeof LegacySlotSchema>;
