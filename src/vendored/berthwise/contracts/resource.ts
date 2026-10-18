import { z } from "zod";
import { hoursBetween, isoUtcString, positiveNumber, resourceIdString } from "./shared";

/** Version of the ResourceAvailability wire contract. */
export const RESOURCE_CONTRACT_VERSION = "1.0.0";

export const ResourceTypeSchema = z.enum(["berth", "crane", "yard-block", "tug"]);
export type ResourceType = z.infer<typeof ResourceTypeSchema>;

/**
 * ResourceAvailability — a resource's usable window and capacity.
 *
 * `capacityUnit` is an explicit unit string ("moves/hour", "TEU",
 * "cranes", "bollards") so a quantity is never a bare number whose unit is
 * tribal knowledge.
 *
 * Refinements carry the Phase B invariants into the contract:
 * - a `berth` resource MUST declare `berthLengthM` and `maxDraftM` (berth
 *   depth). Without a declared depth the draft-vs-depth gate cannot run, so
 *   the record is rejected rather than admitted with an unknown depth.
 * - optional `grainCapable` / `cranes` let the feasibility gate apply the
 *   audited length / grain / crane rules before any solver runs.
 */
export const ResourceAvailabilitySchema = z
  .object({
    contractVersion: z.literal(RESOURCE_CONTRACT_VERSION).default(RESOURCE_CONTRACT_VERSION),
    resourceId: resourceIdString,
    resourceType: ResourceTypeSchema,
    /** Explicit unit, e.g. "moves/hour", "TEU", "cranes". */
    capacityUnit: z.string().min(1).max(64),
    /** Capacity in `capacityUnit`; must be finite and positive. */
    quantity: positiveNumber("quantity", 1_000_000),
    /** ISO UTC start of availability. */
    availableFromUtc: isoUtcString,
    /** ISO UTC end of availability; strictly after availableFromUtc. */
    availableToUtc: isoUtcString,
    /** Berth quay length in metres (required for berth resources). */
    berthLengthM: positiveNumber("berthLengthM", 1000).optional(),
    /** Maintained depth alongside the berth in metres (required for berth resources). */
    maxDraftM: positiveNumber("maxDraftM", 30).optional(),
    /** Whether the berth can handle grain bulkers (berth resources). */
    grainCapable: z.boolean().optional(),
    /** Quay cranes installed at the berth (berth resources). */
    cranes: z.number().int().min(0).max(20).optional(),
  })
  .superRefine((r, ctx) => {
    if (hoursBetween(r.availableFromUtc, r.availableToUtc) <= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["availableToUtc"],
        message: "availableToUtc must be strictly after availableFromUtc",
      });
    }
    if (r.resourceType === "berth") {
      if (r.berthLengthM === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["berthLengthM"],
          message: "berth resources must declare berthLengthM (length feasibility gate)",
        });
      }
      if (r.maxDraftM === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["maxDraftM"],
          message: "berth resources must declare maxDraftM (draft-vs-depth gate)",
        });
      }
    }
  });

export type ResourceAvailability = z.infer<typeof ResourceAvailabilitySchema>;
