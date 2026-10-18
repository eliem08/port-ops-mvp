import { z } from "zod";

/**
 * Shared primitives for the berthwise versioned contracts.
 *
 * Every contract module pins a `*_CONTRACT_VERSION` constant and carries the
 * version on each record (`contractVersion`, defaulted), so a future
 * migration can distinguish wire formats without guessing.
 */

/**
 * Strict ISO-8601 UTC timestamp. The contract demands UTC explicitly: a bare
 * local-time string or a non-zero offset is rejected, because every planning
 * timestamp is compared across vessels and resources and a mixed-offset feed
 * would silently shift windows.
 */
export const isoUtcString = z.string().refine(
  (s) => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|\+00:00)$/.test(s)) {
      return false;
    }
    return !Number.isNaN(Date.parse(s));
  },
  { message: "must be an ISO 8601 UTC timestamp, e.g. 2026-10-18T06:00:00Z" },
);

export type IsoUtcString = z.infer<typeof isoUtcString>;

/** Milliseconds since epoch for a validated ISO UTC string. */
export function toMs(iso: string): number {
  return Date.parse(iso);
}

/** Whole-or-fractional hours from `fromIso` to `toIso` (may be negative). */
export function hoursBetween(fromIso: string, toIso: string): number {
  return (toMs(toIso) - toMs(fromIso)) / 3_600_000;
}

const nonEmptyString = (max: number) =>
  z.string().min(1, { message: "must be a non-empty string" }).max(max);

/** Finite number strictly greater than zero (NaN/Infinity rejected). */
const positiveNumber = (label: string, max?: number) =>
  z
    .number()
    .refine((n) => Number.isFinite(n) && n > 0, {
      message: `${label} must be a finite number > 0`,
    })
    .refine((n) => max === undefined || n <= max, {
      message: `${label} must be <= ${max} (sanity bound)`,
    });

export const vesselIdString = nonEmptyString(64);
export const resourceIdString = nonEmptyString(64);
export const planIdString = nonEmptyString(64);

export { nonEmptyString, positiveNumber };
