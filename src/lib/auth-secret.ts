// Session-signing secret — SINGLE SOURCE OF TRUTH.
// Deliberately has NO node:sqlite (or any Node-only) dependency so the edge
// middleware can import it too. Previously the secret fallback string was
// duplicated in src/middleware.ts; drift there would have silently broken
// the auth gate or, worse, split-brained session verification.
//
// Security contract:
// - In production (NODE_ENV=production) with AUTH_SECRET (or legacy DEMO_AUTH_SECRET) unset:
//   getSecretBytes() THROWS. The app refuses to sign or verify sessions
//   with the publicly known fallback. src/instrumentation.ts calls this
//   at boot so the refusal happens at startup, not on first login.
// - In development/test with neither variable set: warns loudly once
//   and uses the dev-only fallback. Demo sessions are forgeable by anyone
//   with repo access — never expose a dev-secret instance publicly.

let warned = false;

/**
 * True while `next build` is running (not serving traffic). The production
 * secret refusal must not fire here — builds run as NODE_ENV=production but
 * never serve a request. The refusal fires at server startup via
 * src/instrumentation.ts and defensively on every getSecretBytes() call.
 */
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

/** Publicly known placeholder secrets — must never be accepted in production. */
const KNOWN_BAD_SECRETS = new Set([
  "dev-only-change-me-in-production", // code fallback
  "dev-secret-change-me-in-production", // .env dev placeholder
  "change-me-in-production", // .env.example placeholder
]);

export function getSecretBytes(): Uint8Array {
  // AUTH_SECRET is the current name; DEMO_AUTH_SECRET is still honored so
  // existing deployments keep their sessions across the upgrade.
  const raw = process.env.AUTH_SECRET || process.env.DEMO_AUTH_SECRET;
  // In production (and not during `next build`), a missing/placeholder/short
  // secret is a hard refusal — the app must not serve forgeable sessions.
  const enforcing = process.env.NODE_ENV === "production" && !isBuildPhase;
  if (!raw) {
    if (enforcing) {
      throw new Error(
        "[auth] AUTH_SECRET (legacy: DEMO_AUTH_SECRET) is not set in production. Refusing to run " +
          "with the publicly known fallback secret — sessions would be " +
          "forgeable by anyone. Set AUTH_SECRET to a random 32+ byte value."
      );
    }
    if (!warned) {
      warned = true;
      console.warn(
        "[auth] AUTH_SECRET is not set — using the dev-only fallback secret. " +
          "Sessions are forgeable by anyone with repo access. Never expose publicly."
      );
    }
    return new TextEncoder().encode("dev-only-change-me-in-production");
  }
  if (enforcing) {
    // A set-but-publicly-known secret is as bad as unset: the fallback
    // string and the .env/.env.example placeholders are in the repo.
    if (KNOWN_BAD_SECRETS.has(raw)) {
      throw new Error(
        "[auth] AUTH_SECRET in production is a publicly known placeholder " +
          "value. Refusing to run — set it to a random 32+ byte value."
      );
    }
    if (raw.length < 32) {
      throw new Error(
        "[auth] AUTH_SECRET in production is shorter than 32 characters. " +
          "Refusing to run — use a random 32+ byte value."
      );
    }
  }
  return new TextEncoder().encode(raw);
}

/** Test-only reset for the once-per-process dev warning. */
export function __resetSecretWarningForTests(): void {
  warned = false;
}
