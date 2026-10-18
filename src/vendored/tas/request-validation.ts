/**
 * lib/request-validation.ts
 *
 * Shared runtime validation for BookingRequest / SlotAssignment payloads
 * received by the API routes. The messages are the contract the routes
 * return with HTTP 400 — keep them stable.
 *
 * Pure functions — no I/O, no framework.
 */

import { HORIZON_DAYS } from "./types";
import { TERMINALS } from "./data";

const CARGOS = ["general", "grain", "reefer", "hazmat"] as const;
const MOVES = ["import", "export"] as const;
const TERMINAL_IDS = [...TERMINALS.map((t) => t.id), "any"] as const;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Validate one raw object against the BookingRequest contract. */
export function validateBookingRequest(v: unknown, i: number): string | null {
  if (!isRecord(v)) return `requests[${i}] must be an object`;
  if (typeof v.id !== "string" || !v.id.trim())
    return `requests[${i}].id must be a non-empty string`;
  if (typeof v.company !== "string" || !v.company.trim())
    return `requests[${i}].company must be a non-empty string`;
  if (typeof v.truckPlate !== "string")
    return `requests[${i}].truckPlate must be a string`;
  if (!CARGOS.includes(v.cargo as (typeof CARGOS)[number]))
    return `requests[${i}].cargo must be one of ${CARGOS.join(", ")}`;
  if (!MOVES.includes(v.move as (typeof MOVES)[number]))
    return `requests[${i}].move must be one of ${MOVES.join(", ")}`;
  if (v.containers !== 1 && v.containers !== 2)
    return `requests[${i}].containers must be 1 or 2`;
  const ps = num(v.preferredStart);
  const pe = num(v.preferredEnd);
  if (ps === null || ps < 0 || ps >= 1440)
    return `requests[${i}].preferredStart must be minutes since midnight (0–1439)`;
  if (pe === null || pe < 0 || pe >= 1440)
    return `requests[${i}].preferredEnd must be minutes since midnight (0–1439)`;
  if (ps >= pe)
    return `requests[${i}].preferredStart must be before preferredEnd`;
  const lt = num(v.leadTimeHours);
  if (lt === null || lt < 0)
    return `requests[${i}].leadTimeHours must be a non-negative number`;
  const hr = num(v.driverNoShowRate);
  if (hr === null || hr < 0 || hr > 1)
    return `requests[${i}].driverNoShowRate must be between 0 and 1`;
  if (num(v.createdAt) === null)
    return `requests[${i}].createdAt must be a number`;
  if (v.day !== undefined && v.day !== null) {
    const d = num(v.day);
    if (
      d === null ||
      !Number.isInteger(d) ||
      d < 0 ||
      d >= HORIZON_DAYS
    )
      return `requests[${i}].day must be an integer 0..${HORIZON_DAYS - 1}`;
  }
  if (v.terminal !== undefined && v.terminal !== null) {
    if (
      typeof v.terminal !== "string" ||
      !(TERMINAL_IDS as readonly string[]).includes(v.terminal)
    )
      return `requests[${i}].terminal must be one of ${TERMINAL_IDS.join(", ")}`;
  }
  return null;
}

/**
 * Validate one raw object against the SlotAssignment contract (the fields
 * replanning actually reads). Cosmetic fields are type-checked only when
 * present.
 */
export function validateSlotAssignment(v: unknown, i: number): string | null {
  if (!isRecord(v)) return `assignments[${i}] must be an object`;
  if (typeof v.requestId !== "string" || !v.requestId.trim())
    return `assignments[${i}].requestId must be a non-empty string`;
  if (v.gate !== 0 && v.gate !== 1 && v.gate !== 2)
    return `assignments[${i}].gate must be 0, 1 or 2`;
  const ss = num(v.slotStart);
  if (ss === null || ss < 0 || ss >= 1440)
    return `assignments[${i}].slotStart must be minutes since midnight (0–1439)`;
  if (v.rescheduled !== undefined && typeof v.rescheduled !== "boolean")
    return `assignments[${i}].rescheduled must be a boolean`;
  const nsp = num(v.noShowProbability);
  if (
    v.noShowProbability !== undefined &&
    (nsp === null || nsp < 0 || nsp > 1)
  )
    return `assignments[${i}].noShowProbability must be between 0 and 1`;
  const w = num(v.waitEstimateMin);
  if (v.waitEstimateMin !== undefined && (w === null || w < 0))
    return `assignments[${i}].waitEstimateMin must be a non-negative number`;
  if (v.day !== undefined && v.day !== null) {
    const d = num(v.day);
    if (
      d === null ||
      !Number.isInteger(d) ||
      d < 0 ||
      d >= HORIZON_DAYS
    )
      return `assignments[${i}].day must be an integer 0..${HORIZON_DAYS - 1}`;
  }
  if (v.terminal !== undefined && v.terminal !== null) {
    if (
      typeof v.terminal !== "string" ||
      !["T1", "T2", "T3"].includes(v.terminal)
    )
      return `assignments[${i}].terminal must be one of T1, T2, T3`;
  }
  return null;
}
