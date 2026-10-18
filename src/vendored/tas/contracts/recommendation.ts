/**
 * lib/contracts/recommendation.ts
 *
 * Versioned API contract for optimizer recommendations (Phase C).
 *
 * Contract version: "1.0.0" (RECOMMENDATION_CONTRACT_VERSION).
 * payload is validated per recommendation type via a discriminated union,
 * so an unknown `type` or a mismatched payload fails closed.
 * parseRecommendation() never throws — it returns typed issues.
 */

import { z } from "zod";
import { UtcDatetime, type ContractIssue, type ParseResult } from "./appointment";

export const RECOMMENDATION_CONTRACT_VERSION = "1.0.0" as const;

export const RecommendationStatus = z.enum(["proposed", "approved", "rejected"]);
export type RecommendationStatus = z.infer<typeof RecommendationStatus>;

const ApptId = z.string().regex(/^appt_[A-Za-z0-9_-]{8,64}$/, {
  message: "appointmentId must look like appt_<ulid|uuid>",
});

const RecommendationPayload = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("reschedule"),
    appointmentId: ApptId,
    newSlotStartUtc: UtcDatetime,
    newSlotEndUtc: UtcDatetime,
    reason: z.string().min(1).max(500),
  }),
  z.object({
    type: z.literal("cancel-booking"),
    appointmentId: ApptId,
    reason: z.string().min(1).max(500),
  }),
  z.object({
    type: z.literal("reallocate-gate"),
    appointmentId: ApptId,
    newGate: z.string().min(1).max(16),
    reason: z.string().min(1).max(500),
  }),
  z.object({
    type: z.literal("notify-carrier"),
    carrier: z.string().min(1).max(120),
    message: z.string().min(1).max(1000),
    appointmentIds: z.array(ApptId).max(100).optional(),
  }),
]);
export type RecommendationPayload = z.infer<typeof RecommendationPayload>;

export const RecommendationContract = z
  .object({
    id: z.string().regex(/^rec_[A-Za-z0-9_-]{8,64}$/, {
      message: "id must look like rec_<ulid|uuid>",
    }),
    payload: RecommendationPayload,
    rationale: z.string().min(1).max(2000),
    createdAtUtc: UtcDatetime,
    status: RecommendationStatus,
    approvedBy: z.string().min(1).max(120).optional(),
    approvedAtUtc: UtcDatetime.optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.status !== "proposed") {
      if (!r.approvedBy) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "approvedBy is required once the recommendation is decided",
          path: ["approvedBy"],
        });
      }
      if (!r.approvedAtUtc) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "approvedAtUtc is required once the recommendation is decided",
          path: ["approvedAtUtc"],
        });
      }
    }
  });
export type Recommendation = z.infer<typeof RecommendationContract>;

/** Creation payload: everything except server-assigned fields. */
export const RecommendationCreateInput = z
  .object({
    payload: RecommendationPayload,
    rationale: z.string().min(1).max(2000),
  })
  .strict();
export type RecommendationCreateInput = z.infer<typeof RecommendationCreateInput>;

/** Server-side id factory: rec_<26-char ULID> (timestamp-ordered). */
export function newRecommendationId(nowMs: number = Date.now()): string {
  const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let n = nowMs;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[n % 32] + time;
    n = Math.floor(n / 32);
  }
  let rand = "";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] % 32];
  return `rec_${time}${rand}`;
}

function toIssues(error: z.ZodError): ContractIssue[] {
  return error.issues.map((i) => ({
    path: i.path.map(String).join(".") || "(root)",
    code: String(i.code),
    message: i.message,
  }));
}

/**
 * Parse an unknown value against the RecommendationContract.
 * Never throws — returns { ok, value?, issues }.
 */
export function parseRecommendation(v: unknown): ParseResult<Recommendation> {
  const r = RecommendationContract.safeParse(v);
  if (r.success) return { ok: true, value: r.data, issues: [] };
  return { ok: false, issues: toIssues(r.error) };
}

/** Validate a create payload. Never throws. */
export function parseRecommendationCreateInput(
  v: unknown,
): ParseResult<RecommendationCreateInput> {
  const r = RecommendationCreateInput.safeParse(v);
  if (r.success) return { ok: true, value: r.data, issues: [] };
  return { ok: false, issues: toIssues(r.error) };
}

/** Legal recommendation status transitions (proposed is the only origin). */
export const RECOMMENDATION_TRANSITIONS: Record<
  RecommendationStatus,
  RecommendationStatus[]
> = {
  proposed: ["approved", "rejected"],
  approved: [],
  rejected: [],
};

/** Validate a recommendation status transition. Never throws. */
export function validateRecommendationTransition(
  from: unknown,
  to: unknown,
): ContractIssue[] {
  const r = z
    .object({ from: RecommendationStatus, to: RecommendationStatus })
    .safeParse({ from, to });
  if (!r.success) {
    return r.error.issues.map((i) => ({
      path: i.path.map(String).join(".") || "(root)",
      code: String(i.code),
      message: i.message,
    }));
  }
  if (!RECOMMENDATION_TRANSITIONS[r.data.from].includes(r.data.to)) {
    return [
      {
        path: "to",
        code: "custom",
        message: `illegal recommendation transition: ${r.data.from} → ${r.data.to}`,
      },
    ];
  }
  return [];
}
