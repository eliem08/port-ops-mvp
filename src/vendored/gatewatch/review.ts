/**
 * Human review queue + accuracy accounting (pure logic; storage handled by
 * callers).
 *
 * Any scan whose OCR confidence falls below the operator's threshold is
 * routed here instead of auto-accepting: the operator approves the read
 * as-is or corrects the plate/container. Every decision is recorded, so
 * the accuracy panel can report what the automation actually got right.
 */

export type ReviewStatus = 'pending' | 'approved' | 'corrected';

export type ReviewItem = {
  id: string;
  /** Id of the originating batch item. */
  batchId: string;
  imageName: string;
  imageUrl: string;
  ocrPlate: string;
  ocrContainer: string;
  /** OCR confidence, 0–100, at scan time. */
  confidence: number;
  /** Editable values — start as the OCR read, updated by the operator. */
  plate: string;
  container: string;
  status: ReviewStatus;
  decidedAt: number | null;
};

/** Default confidence threshold below which a scan needs human review. */
export const DEFAULT_REVIEW_THRESHOLD = 70;

/**
 * Decides whether a scan needs human review.
 *
 * SAFETY: a non-finite confidence (NaN/Infinity — e.g. a corrupt worker
 * payload) ALWAYS needs review. Without this guard `NaN < threshold` is
 * false, which would silently auto-accept the read.
 *
 * Phase D hardening: the confidence scale is contractually 0–100
 * (ConfidenceSchema in contracts.ts). A confidence OUTSIDE that range —
 * negative, or above 100 — is by definition a corrupt/hostile payload and
 * fails closed to human review. (Before this fix, a finite confidence of
 * 101 sailed through to auto-accept.)
 * @param confidence OCR confidence 0–100.
 * @param threshold review threshold (exclusive: exactly at threshold passes).
 * @returns true when the scan must go to the review queue.
 */
export function needsReview(confidence: number, threshold: number): boolean {
  if (!Number.isFinite(confidence)) return true;
  if (confidence < 0 || confidence > 100) return true;
  return confidence < threshold;
}

/**
 * Verdict routing for a finished scan. This is the single choke point that
 * decides whether an OCR read may auto-accept or must go to a human.
 *
 * SAFETY INVARIANT (locked by tests in review.test.ts): OCR failure or
 * below-threshold confidence NEVER auto-accepts. The three paths are:
 * - 'scan-failed'   — the OCR engine threw or the image could not be
 *                      decoded. The item is marked failed; it is never
 *                      verified against the slot registry and never logged
 *                      as an auto-accepted crossing.
 * - 'human-review'   — confidence below the operator's threshold (or
 *                      non-finite). An operator approves or corrects the
 *                      read before anything is verified or logged.
 * - 'auto-accept'    — confidence at/above the threshold. The read is
 *                      verified against the slot registry and logged.
 *
 * The verdicts themselves are UI-only records — no code path here
 * opens a gate or authorizes access (see matchSlot in slots.ts).
 */
export type ScanRouting = 'auto-accept' | 'human-review' | 'scan-failed';

export function routeScan(
  scan: { error: string | null; confidence: number },
  threshold: number,
): ScanRouting {
  if (scan.error) return 'scan-failed';
  if (needsReview(scan.confidence, threshold)) return 'human-review';
  return 'auto-accept';
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `review-${Date.now().toString(36)}-${seq}`;
}

/**
 * Creates a pending review item from a finished scan.
 * @param args scan details.
 * @returns pending review item.
 */
export function createReviewItem(args: {
  batchId: string;
  imageName: string;
  imageUrl: string;
  ocrPlate: string;
  ocrContainer: string;
  confidence: number;
}): ReviewItem {
  return {
    id: nextId(),
    batchId: args.batchId,
    imageName: args.imageName,
    imageUrl: args.imageUrl,
    ocrPlate: args.ocrPlate,
    ocrContainer: args.ocrContainer,
    confidence: args.confidence,
    plate: args.ocrPlate,
    container: args.ocrContainer,
    status: 'pending',
    decidedAt: null,
  };
}

/**
 * Records a decision on one review item. Approving keeps the OCR values;
 * correcting replaces them with the operator's values. A correction counts
 * when at least one field differs from the OCR read.
 * @param items review items.
 * @param id item id.
 * @param decision approve-as-is or corrected values.
 * @returns new array with the item decided (unchanged items keep identity).
 */
export function applyReviewDecision(
  items: ReviewItem[],
  id: string,
  decision:
    | { kind: 'approve' }
    | { kind: 'correct'; plate: string; container: string },
): ReviewItem[] {
  return items.map((item) => {
    if (item.id !== id) return item;
    if (decision.kind === 'approve') {
      return { ...item, plate: item.ocrPlate, container: item.ocrContainer, status: 'approved', decidedAt: Date.now() };
    }
    const changed =
      decision.plate !== item.ocrPlate || decision.container !== item.ocrContainer;
    return {
      ...item,
      plate: decision.plate,
      container: decision.container,
      // Saving identical values is an approval, not a correction.
      status: changed ? 'corrected' : 'approved',
      decidedAt: Date.now(),
    };
  });
}

/**
 * Accuracy accounting across the whole shift.
 * @param args total scans (gate-log entries + still-pending reviews) and all
 * review items ever created.
 * @returns auto-accept rate, correction rate, and supporting counts.
 */
export function computeAccuracy(args: {
  totalScans: number;
  reviewItems: ReviewItem[];
}): {
  totalScans: number;
  autoAccepted: number;
  autoAcceptRate: number;
  reviewed: number;
  corrected: number;
  correctionRate: number;
  avgReviewConfidence: number;
} {
  const { totalScans, reviewItems } = args;
  const decided = reviewItems.filter((i) => i.status !== 'pending');
  const corrected = reviewItems.filter((i) => i.status === 'corrected').length;
  const autoAccepted = Math.max(0, totalScans - reviewItems.length);
  const avgReviewConfidence =
    reviewItems.length > 0
      ? reviewItems.reduce((acc, i) => acc + i.confidence, 0) / reviewItems.length
      : 0;
  return {
    totalScans,
    autoAccepted,
    autoAcceptRate: totalScans > 0 ? autoAccepted / totalScans : 0,
    reviewed: decided.length,
    corrected,
    correctionRate: decided.length > 0 ? corrected / decided.length : 0,
    avgReviewConfidence,
  };
}
