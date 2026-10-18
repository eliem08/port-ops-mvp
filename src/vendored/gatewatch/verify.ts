/**
 * Pure verification of a gate scan against the minimal appointment reference.
 *
 * Decision rules (every one test-covered):
 * - cancelled appointment                     → denied
 * - requested (unconfirmed) appointment       → manual-review
 * - terminal appointment (completed/no-show)  → denied
 * - container or plate mismatch               → denied (identifiers must
 *                                               match exactly — the demo
 *                                               never guesses)
 * - scan outside the slot window              → manual-review
 * - scan at a different gate                  → manual-review
 * - OCR confidence below threshold            → manual-review
 * - no appointment reference supplied         → manual-review
 * - everything matches                        → authorized
 *
 * Normalization mirrors slots.ts (case/space/dash-insensitive) so OCR
 * quirks like "MSKU 739201 7" still verify against "MSKU739201-7".
 *
 * NOTE: an "authorized" decision here is still UI-only — no code path in
 * this demo opens a gate (see review.ts verdict routing). In production
 * this decision would feed a server-side authorization service, never a
 * client-side verdict.
 */

import {
  AUTH_CONFIDENCE_THRESHOLD,
  type AppointmentRef,
  type VerificationDecision,
} from './contracts';

export const REASON_CODES = {
  VERIFIED_MATCH: 'verified-match',
  CONTAINER_MISMATCH: 'container-mismatch',
  PLATE_MISMATCH: 'plate-mismatch',
  OUTSIDE_SLOT_WINDOW: 'outside-slot-window',
  GATE_MISMATCH: 'gate-mismatch',
  LOW_CONTAINER_CONFIDENCE: 'low-container-confidence',
  LOW_PLATE_CONFIDENCE: 'low-plate-confidence',
  APPOINTMENT_CANCELLED: 'appointment-cancelled',
  APPOINTMENT_NOT_ACTIVE: 'appointment-not-active',
  /** Appointment exists but was never confirmed — an operator decides. */
  APPOINTMENT_UNCONFIRMED: 'appointment-unconfirmed',
  /** Adapter failure: the TAS payload was not a valid contract document. */
  APPOINTMENT_REF_INVALID: 'appointment-ref-invalid',
  NO_APPOINTMENT_REF: 'no-appointment-ref',
} as const;

export type ScanInput = {
  plate: string;
  containerNumber: string;
  scannedAtUtc: string;
  gate: string;
  containerConfidence: number;
  plateConfidence: number;
};

function normalize(value: string): string {
  return (value ?? '').toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Verifies one scanned crossing against one appointment reference.
 *
 * @param scanned the scan to verify.
 * @param appointmentRef the minimal TAS appointment shape, or null when the
 *   scan carries no appointment reference.
 * @returns decision + machine-readable reason codes.
 */
export function verifyGateEventAgainstAppointment(
  scanned: ScanInput,
  appointmentRef: AppointmentRef | null,
): VerificationDecision {
  const reasonCodes: string[] = [];

  // Low-confidence OCR can never clear automatically, no matter what else
  // matches — route to a human.
  //
  // Phase D hardening (defense in depth behind routeScan and the
  // submission schema): the confidence scale is contractually 0–100, so
  // a non-finite OR out-of-range confidence is a corrupt/hostile payload
  // and fails closed here too. Before this fix, a finite confidence of
  // 101 sailed past the threshold check (`101 < 70` is false) and could
  // authorize a perfectly matching scan. The OCR wrapper (ocr.ts)
  // coerces non-finite to 0 but does not clamp >100, so this guard is
  // reachable from a hostile worker, not just theoretical.
  const confidenceSane = (c: number): boolean =>
    Number.isFinite(c) && c >= 0 && c <= 100;
  if (
    !confidenceSane(scanned.containerConfidence) ||
    scanned.containerConfidence < AUTH_CONFIDENCE_THRESHOLD
  ) {
    reasonCodes.push(REASON_CODES.LOW_CONTAINER_CONFIDENCE);
  }
  if (
    !confidenceSane(scanned.plateConfidence) ||
    scanned.plateConfidence < AUTH_CONFIDENCE_THRESHOLD
  ) {
    reasonCodes.push(REASON_CODES.LOW_PLATE_CONFIDENCE);
  }

  if (!appointmentRef) {
    reasonCodes.push(REASON_CODES.NO_APPOINTMENT_REF);
    return { decision: 'manual-review', reasonCodes };
  }

  if (appointmentRef.status === 'cancelled') {
    reasonCodes.push(REASON_CODES.APPOINTMENT_CANCELLED);
    return { decision: 'denied', reasonCodes };
  }
  // A "requested" appointment exists but was never confirmed — this is an
  // operator call, not a denial (the truck may be held at the gate).
  if (appointmentRef.status === 'requested') {
    reasonCodes.push(REASON_CODES.APPOINTMENT_UNCONFIRMED);
    return { decision: 'manual-review', reasonCodes };
  }
  // Terminal statuses (completed, no-show) can never clear a scan.
  if (
    appointmentRef.status !== 'confirmed' &&
    appointmentRef.status !== 'checked-in'
  ) {
    reasonCodes.push(REASON_CODES.APPOINTMENT_NOT_ACTIVE);
    return { decision: 'denied', reasonCodes };
  }

  // Hard identifier checks — mismatch denies, it does not defer.
  if (normalize(scanned.containerNumber) !== normalize(appointmentRef.containerNumber)) {
    reasonCodes.push(REASON_CODES.CONTAINER_MISMATCH);
    return { decision: 'denied', reasonCodes };
  }
  if (normalize(scanned.plate) !== normalize(appointmentRef.plate)) {
    reasonCodes.push(REASON_CODES.PLATE_MISMATCH);
    return { decision: 'denied', reasonCodes };
  }

  // Gate mismatch defers (a human re-assigns the lane), window mismatch
  // defers (early/late arrivals are an operator call, not a denial).
  if (normalize(scanned.gate) !== normalize(String(appointmentRef.gate))) {
    reasonCodes.push(REASON_CODES.GATE_MISMATCH);
    return { decision: 'manual-review', reasonCodes };
  }

  const scannedAt = new Date(scanned.scannedAtUtc);
  const start = new Date(appointmentRef.slotStartUtc);
  const end = new Date(appointmentRef.slotEndUtc);
  if (scannedAt < start || scannedAt > end) {
    reasonCodes.push(REASON_CODES.OUTSIDE_SLOT_WINDOW);
    return { decision: 'manual-review', reasonCodes };
  }

  // Confidence failures already pushed above — anything left here that
  // matched identifiers, gate and window goes to a human when the read
  // itself was shaky.
  if (reasonCodes.length > 0) {
    return { decision: 'manual-review', reasonCodes };
  }

  reasonCodes.push(REASON_CODES.VERIFIED_MATCH);
  return { decision: 'authorized', reasonCodes };
}
