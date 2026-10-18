import { z } from "zod";
import { isoUtcString } from "./shared";

/** Version of the OptimizationRecommendation wire contract. */
export const RECOMMENDATION_CONTRACT_VERSION = "1.0.0";

export const RecommendationStatusSchema = z.enum(["proposed", "approved", "rejected"]);
export type RecommendationStatus = z.infer<typeof RecommendationStatusSchema>;

/**
 * OptimizationRecommendation — a planner suggestion plus its approval flow.
 *
 * NOTE (intentional duplication): this shape deliberately mirrors the
 * OptimizationRecommendation used by TAS (the yard-side service) — same
 * fields, same lifecycle — but the two are NOT shared. There is no common
 * backend and no shared package on purpose: berth planning and yard planning
 * release independently, and a shared contract would couple their deploys.
 * Keep the shapes in sync by convention and code review, never by import.
 *
 * Approval invariant: a recommendation that has left `proposed` must carry
 * `approvedAtUtc`, and an `approved` one must name its `approvedBy`. A
 * rejection without a timestamp is rejected at the boundary.
 */
export const OptimizationRecommendationSchema = z
  .object({
    contractVersion: z.literal(RECOMMENDATION_CONTRACT_VERSION).default(RECOMMENDATION_CONTRACT_VERSION),
    id: z.string().min(1).max(64),
    /** Machine-readable kind, e.g. "re-sequence", "swap-berth", "add-crane". */
    type: z.string().min(1).max(64),
    /** Opaque JSON payload describing the suggested change. */
    payload: z.record(z.string(), z.unknown()),
    /** Human-readable justification shown to the approver. */
    rationale: z.string().min(1).max(2000),
    createdAtUtc: isoUtcString,
    status: RecommendationStatusSchema,
    approvedBy: z.string().min(1).max(128).optional(),
    approvedAtUtc: isoUtcString.optional(),
  })
  .superRefine((r, ctx) => {
    if (r.status !== "proposed" && r.approvedAtUtc === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["approvedAtUtc"],
        message: `a ${r.status} recommendation must carry approvedAtUtc`,
      });
    }
    if (r.status === "approved" && r.approvedBy === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["approvedBy"],
        message: "an approved recommendation must name its approver",
      });
    }
  });

export type OptimizationRecommendation = z.infer<typeof OptimizationRecommendationSchema>;
