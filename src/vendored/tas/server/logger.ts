/**
 * lib/server/logger.ts
 *
 * Phase E — structured server-side logging + error-tracking seam.
 *
 * ------------------------------------------------------------------
 * RULES (deployment-readiness contract)
 * ------------------------------------------------------------------
 * 1. ONE JSON line per event, written to stderr (never stdout — stdout
 *    is the response channel and must stay clean for proxies/parsers).
 * 2. NEVER log PII: no names, emails, phone numbers. The redactor below
 *    scrubs email addresses and phone-like strings from every string it
 *    sees (defense in depth); callers must still avoid passing PII in.
 * 3. NEVER log request bodies. Pass only codes and small metadata.
 * 4. NEVER include stack traces in the logged object: Error instances
 *    are reduced to { name, message } before serialization.
 *
 * Line shape:
 *   { ts, level, service, route, code, detail? }
 * ts is an ISO-8601 UTC timestamp (new Date().toISOString()).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const SERVICE = "tas-casablanca";

// Email: user@example.com style addresses.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone-like: a run of digits with common separators that contains
// at least 10 digits in total (covers +212 661 282 281, (212)661-282-281,
// 0661 282 281, 212661282281 …). Short numeric codes (slot minutes,
// truck counts) have far fewer digits and pass through untouched.
const PHONE_CANDIDATE_RE = /\+?[\d][\d\s().-]{7,}[\d]/g;

function digitCount(s: string): number {
  let n = 0;
  for (const ch of s) if (ch >= "0" && ch <= "9") n++;
  return n;
}

function redactString(s: string): string {
  let out = s.replace(EMAIL_RE, "[redacted-email]");
  out = out.replace(PHONE_CANDIDATE_RE, (m) =>
    digitCount(m) >= 10 ? "[redacted-phone]" : m,
  );
  return out;
}

/**
 * Recursively redacts PII from a detail object and reduces Error
 * instances to { name, message } (stack traces never leave the process).
 * Unknown/circular structures are handled defensively.
 */
export function redactDetail(value: unknown, seen = new Set<unknown>()): unknown {
  if (typeof value === "string") return redactString(value);
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => redactDetail(v, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = redactDetail(v, seen);
  }
  return out;
}

/**
 * Summarizes a thrown value for the log line: { name, message } only.
 * Never includes the stack trace.
 */
export function errorSummary(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  const message =
    typeof error === "string"
      ? error
      : (() => {
          try {
            return JSON.stringify(error);
          } catch {
            return String(error);
          }
        })();
  return { name: "UnknownError", message: String(message) };
}

/**
 * Writes a single structured JSON line to stderr.
 *
 * @param level   severity: debug | info | warn | error
 * @param route   logical route name, e.g. "POST /api/optimize"
 * @param code    stable machine code, e.g. "internal_error"
 * @param detail  small metadata object (no bodies, no PII; auto-redacted)
 */
export function logEvent(
  level: LogLevel,
  route: string,
  code: string,
  detail?: Record<string, unknown>,
): void {
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    service: SERVICE,
    route,
    code,
  };
  if (detail !== undefined) {
    record.detail = redactDetail(detail);
  }
  process.stderr.write(JSON.stringify(record) + "\n");
}

/**
 * reportError — ERROR-TRACKING SEAM (Phase E).
 *
 * This is the single place where a production error tracker (e.g.
 * Sentry) would be wired in. It is INTENTIONALLY NOT WIRED: there is
 * no ERROR_TRACKING_DSN, no @sentry/* dependency in package.json, and
 * this function is a deliberate no-op. Structured logging (logEvent)
 * is currently the only failure sink.
 *
 * When the project adopts error tracking, the integration is exactly
 * three lines inside this function:
 *
 *   import * as Sentry from "@sentry/nextjs";              // 1. add the dep
 *   Sentry.init({ dsn: process.env.ERROR_TRACKING_DSN });  // 2. init once at startup
 *   Sentry.captureException(error, { tags: { route, code } }); // 3. report here
 *
 * Do NOT scatter Sentry.captureException calls through the routes;
 * keep all reporting funneled through this seam.
 */
export function reportError(
  _route: string,
  _code: string,
  _error: unknown,
): void {
  // No-op by design. See the comment block above.
}
