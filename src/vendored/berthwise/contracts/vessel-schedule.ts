import { z } from "zod";
import { hoursBetween, isoUtcString, positiveNumber, vesselIdString } from "./shared";

/** Version of the VesselSchedule wire contract. */
export const VESSEL_CONTRACT_VERSION = "1.0.0";

/**
 * VesselSchedule — one vessel's call at the port.
 *
 * Refinements beyond the raw fields enforce the time-ordering invariant the
 * Phase B audit relies on: a schedule whose departure is not after its
 * arrival is rejected at the boundary, never swept into a plan.
 */
export const VesselScheduleSchema = z
  .object({
    contractVersion: z.literal(VESSEL_CONTRACT_VERSION).default(VESSEL_CONTRACT_VERSION),
    /** Stable vessel identifier (maps 1:1 to the planner's vessel id). */
    vesselId: vesselIdString,
    /** Optional IMO number; when present it must be the 7-digit IMO format. */
    imo: z
      .string()
      .regex(/^\d{7}$/, { message: "imo must be a 7-digit IMO number" })
      .optional(),
    name: z.string().min(1).max(120),
    /** Length overall, metres. */
    loaM: positiveNumber("loaM", 500),
    /** Beam, metres. */
    beamM: positiveNumber("beamM", 100),
    /** Loaded draft, metres — drives the tide-window and berth-depth gates. */
    draftM: positiveNumber("draftM", 30),
    /** ISO UTC arrival. */
    etaUtc: isoUtcString,
    /** ISO UTC departure; must be strictly after etaUtc. */
    etdUtc: isoUtcString,
    cargoType: z.enum(["container", "grain"]).optional(),
    /**
     * TEU on board (container vessels). Optional: when absent the planner
     * applies a documented conservative default (see plan-service), and the
     * assumption is surfaced in the generation response.
     */
    teu: z.number().int().min(0).optional(),
  })
  .superRefine((s, ctx) => {
    if (hoursBetween(s.etaUtc, s.etdUtc) <= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["etdUtc"],
        message: "etdUtc must be strictly after etaUtc",
      });
    }
  });

export type VesselSchedule = z.infer<typeof VesselScheduleSchema>;
