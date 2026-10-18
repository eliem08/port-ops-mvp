import { z } from "zod";
import { hoursBetween, isoUtcString, planIdString, vesselIdString } from "./shared";

/** Version of the BerthPlan wire contract. */
export const BERTH_PLAN_CONTRACT_VERSION = "1.0.0";

/** Lifecycle of one berth-plan record. Forward-only: draft → … → completed, or → superseded. */
export const BerthPlanStatusSchema = z.enum([
  "draft",
  "proposed",
  "approved",
  "active",
  "completed",
  "superseded",
]);
export type BerthPlanStatus = z.infer<typeof BerthPlanStatusSchema>;

/**
 * BerthPlan — one vessel's committed berth window.
 *
 * One record per (plan, vessel) assignment; `planId` groups the records of a
 * generation batch and `version` counts supersessions. The schema rejects
 * what the Phase B audit proved invalid: zero/negative windows
 * (`berthEndUtc` must be after `berthStartUtc`) and plans with no cranes
 * assigned.
 */
export const BerthPlanSchema = z
  .object({
    contractVersion: z.literal(BERTH_PLAN_CONTRACT_VERSION).default(BERTH_PLAN_CONTRACT_VERSION),
    planId: planIdString,
    /** Monotonic version within a planId lineage; incremented on supersession. */
    version: z.number().int().min(1),
    vesselId: vesselIdString,
    berthId: z.string().min(1).max(64),
    /** ISO UTC start of the berth occupation. */
    berthStartUtc: isoUtcString,
    /** ISO UTC end of the berth occupation; strictly after berthStartUtc. */
    berthEndUtc: isoUtcString,
    /** Crane ids assigned to this call; at least one — a plan with no crane is not a plan. */
    assignedCranes: z.array(z.string().min(1).max(64)).min(1),
    /** Reference to the tide window that admits a deep-draft entry, when applicable. */
    tideWindowRef: z.string().min(1).max(64).optional(),
    status: BerthPlanStatusSchema,
    createdAtUtc: isoUtcString,
  })
  .superRefine((p, ctx) => {
    if (hoursBetween(p.berthStartUtc, p.berthEndUtc) <= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["berthEndUtc"],
        message: "berthEndUtc must be strictly after berthStartUtc",
      });
    }
  });

export type BerthPlan = z.infer<typeof BerthPlanSchema>;
