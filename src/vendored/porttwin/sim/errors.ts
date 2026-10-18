/**
 * Phase C — structured errors.
 *
 * Every Phase C entry point (scenario loading, run configuration,
 * approvals) reports failures as a `SimError` with a stable machine-
 * readable `code`. Error *responses* exposed to callers are reduced to
 * `{ code, message }` by `toPublicError` — stack traces and internals
 * never leave the boundary. The full error (with `details`) is logged
 * server-side via the optional `onInternalError` hook.
 */

export type SimErrorCode =
  | "VALIDATION_ERROR"
  | "VERSION_MISMATCH"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "INTERNAL_ERROR";

/** HTTP status mapped from each error code (for future API routes). */
const STATUS_BY_CODE: Record<SimErrorCode, number> = {
  VALIDATION_ERROR: 400,
  VERSION_MISMATCH: 422,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL_ERROR: 500,
};

/**
 * Structured simulation-platform error. `details` carries field-level
 * validation failures or version information — never secrets, never
 * stack internals.
 */
export class SimError extends Error {
  readonly code: SimErrorCode;
  readonly details?: unknown;
  readonly statusCode: number;

  constructor(code: SimErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "SimError";
    this.code = code;
    this.details = details;
    this.statusCode = STATUS_BY_CODE[code];
    // Keep the prototype chain intact for `instanceof` after transpilation.
    Object.setPrototypeOf(this, SimError.prototype);
  }
}

/** Public shape of an error: safe to serialize into an API response. */
export interface PublicError {
  code: SimErrorCode;
  message: string;
  /** Field-level failures (validation errors only); no internals. */
  details?: unknown;
}

/**
 * Reduce any thrown value to a safe public error. Non-SimError values
 * (bugs, unexpected throws) become a generic INTERNAL_ERROR with no
 * internals leaked; the original is passed to `onInternalError` so it
 * can be logged server-side.
 */
export function toPublicError(
  err: unknown,
  onInternalError?: (err: unknown) => void
): PublicError {
  if (err instanceof SimError) {
    const out: PublicError = { code: err.code, message: err.message };
    if (err.details !== undefined) out.details = err.details;
    return out;
  }
  onInternalError?.(err);
  return {
    code: "INTERNAL_ERROR",
    message: "An unexpected error occurred. The failure was logged.",
  };
}
