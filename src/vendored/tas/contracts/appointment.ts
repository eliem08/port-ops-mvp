/**
 * lib/contracts/appointment.ts
 *
 * Versioned API contract for truck appointments (Phase C).
 *
 * Contract version: "1.0.0" (APPOINTMENT_CONTRACT_VERSION).
 * All timestamps are ISO 8601 UTC strings (must end in "Z").
 * Validation is done with zod. parseAppointment() / validateAppointment()
 * never throw — they return typed results.
 */

import { z } from "zod";

export const APPOINTMENT_CONTRACT_VERSION = "1.0.0" as const;

/** One structured, machine-readable contract issue (never a raw throw). */
export interface ContractIssue {
  path: string;
  code: string;
  message: string;
}

export interface ParseResult<T> {
  ok: boolean;
  value?: T;
  issues: ContractIssue[];
}

const UTC_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** ISO 8601 UTC datetime string, e.g. "2026-10-20T08:30:00Z". */
export const UtcDatetime = z
  .string()
  .refine(
    (s) => UTC_DATETIME_RE.test(s) && !Number.isNaN(Date.parse(s)),
    { message: "must be an ISO 8601 UTC datetime ending in 'Z'" },
  );

/* ------------------------------------------------------------------ */
/* ISO 6346 container numbers                                          */
/* ------------------------------------------------------------------ */

/**
 * ISO 6346 check digit: owner code (4 letters) + category (U/J/Z) map
 * A=10 … Z=38 (multiples of 11 dropped), each position weighted by
 * 2^position; sum mod 11 (10 → 0) must equal the 11th digit.
 */
const LETTER_VALUES: Record<string, number> = {
  A: 10, B: 12, C: 13, D: 14, E: 15, F: 16, G: 17, H: 18, I: 19, J: 20,
  K: 21, L: 23, M: 24, N: 25, O: 26, P: 27, Q: 28, R: 29, S: 30, T: 31,
  U: 32, V: 34, W: 35, X: 36, Y: 37, Z: 38,
};

function iso6346CheckDigitValid(number: string): boolean {
  const chars = number.toUpperCase().split("");
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const c = chars[i];
    const v =
      c >= "0" && c <= "9" ? Number(c) : (LETTER_VALUES[c] ?? NaN);
    if (Number.isNaN(v)) return false;
    sum += v * 2 ** i;
  }
  const check = sum % 11 === 10 ? 0 : sum % 11;
  return check === Number(chars[10]);
}

/** ISO 6346 container number, e.g. "MSKU1234561" (check digit verified). */
export const ContainerNumber = z
  .string()
  .regex(/^[A-Z]{3}[UJZ][0-9]{7}$/, {
    message: "must match ISO 6346 (3 owner letters + U/J/Z + 7 digits)",
  })
  .refine(iso6346CheckDigitValid, {
    message: "ISO 6346 check digit is invalid",
  });

export const AppointmentStatus = z.enum([
  "requested",
  "confirmed",
  "checked-in",
  "completed",
  "cancelled",
  "no-show",
]);
export type AppointmentStatus = z.infer<typeof AppointmentStatus>;

/** Legal status transitions (the booking state machine). */
export const STATUS_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  requested: ["confirmed", "cancelled"],
  confirmed: ["checked-in", "cancelled"],
  "checked-in": ["completed", "cancelled", "no-show"],
  completed: [],
  cancelled: [],
  "no-show": [],
};

/** { from, to } — zod-validated; only legal transitions pass. */
export const BookingStatusTransition = z
  .object({ from: AppointmentStatus, to: AppointmentStatus })
  .superRefine((t, ctx) => {
    if (!STATUS_TRANSITIONS[t.from].includes(t.to)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `illegal status transition: ${t.from} → ${t.to}`,
        path: ["to"],
      });
    }
  });
export type BookingStatusTransition = z.infer<typeof BookingStatusTransition>;

export const AppointmentContract = z
  .object({
    /** Stable id: "appt_" + ulid/uuid, server-assigned at creation. */
    id: z.string().regex(/^appt_[A-Za-z0-9_-]{8,64}$/, {
      message: "id must look like appt_<ulid|uuid>",
    }),
    status: AppointmentStatus,
    truck: z.object({
      plate: z.string().min(1).max(32),
      carrier: z.string().min(1).max(120),
    }),
    container: z.object({
      number: ContainerNumber,
      type: z.string().min(1).max(32),
    }),
    slot: z
      .object({ startUtc: UtcDatetime, endUtc: UtcDatetime })
      .refine((s) => Date.parse(s.endUtc) > Date.parse(s.startUtc), {
        message: "slot.endUtc must be after slot.startUtc",
      }),
    terminal: z.string().min(1).max(16),
    gate: z.string().min(1).max(16),
    createdAtUtc: UtcDatetime,
    updatedAtUtc: UtcDatetime,
  })
  .strict();
export type Appointment = z.infer<typeof AppointmentContract>;

/** Creation payload: everything except server-assigned fields. */
export const AppointmentCreateInput = z
  .object({
    truck: z.object({
      plate: z.string().min(1).max(32),
      carrier: z.string().min(1).max(120),
    }),
    container: z.object({
      number: ContainerNumber,
      type: z.string().min(1).max(32),
    }),
    slot: z
      .object({ startUtc: UtcDatetime, endUtc: UtcDatetime })
      .refine((s) => Date.parse(s.endUtc) > Date.parse(s.startUtc), {
        message: "slot.endUtc must be after slot.startUtc",
      }),
    terminal: z.string().min(1).max(16),
    gate: z.string().min(1).max(16),
  })
  .strict();
export type AppointmentCreateInput = z.infer<typeof AppointmentCreateInput>;

function toIssues(error: z.ZodError): ContractIssue[] {
  return error.issues.map((i) => ({
    path: i.path.map(String).join(".") || "(root)",
    code: String(i.code),
    message: i.message,
  }));
}

/**
 * Parse an unknown value against the AppointmentContract.
 * Never throws — returns { ok, value?, issues }.
 */
export function parseAppointment(v: unknown): ParseResult<Appointment> {
  const r = AppointmentContract.safeParse(v);
  if (r.success) return { ok: true, value: r.data, issues: [] };
  return { ok: false, issues: toIssues(r.error) };
}

/**
 * Validate an unknown value as an appointment-create payload.
 * Never throws — returns { ok, value?, issues }.
 */
export function parseAppointmentCreateInput(
  v: unknown,
): ParseResult<AppointmentCreateInput> {
  const r = AppointmentCreateInput.safeParse(v);
  if (r.success) return { ok: true, value: r.data, issues: [] };
  return { ok: false, issues: toIssues(r.error) };
}

/**
 * Return the list of contract issues for an unknown value
 * (empty array = valid). Never throws.
 */
export function validateAppointment(v: unknown): ContractIssue[] {
  return parseAppointment(v).issues;
}

/**
 * Validate a status transition { from, to }. Never throws — returns
 * typed issues (empty = legal transition).
 */
export function validateTransition(
  from: unknown,
  to: unknown,
): ContractIssue[] {
  const r = BookingStatusTransition.safeParse({ from, to });
  if (r.success) return [];
  return toIssues(r.error);
}

/** Server-side id factory: appt_<26-char ULID> (timestamp-ordered). */
export function newAppointmentId(nowMs: number = Date.now()): string {
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
  return `appt_${time}${rand}`;
}
