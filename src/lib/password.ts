// Password hashing and policy.
// - scrypt (memory-hard KDF from node:crypto), per-password random salt.
// - Encoded as "scrypt$N$r$p$saltB64$hashB64" so parameters can be raised
//   later without invalidating existing hashes (needsRehash()).
// - Verification is constant-time (timingSafeEqual) and fails closed on any
//   malformed hash.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 1 << 15; // CPU/memory cost
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;
// scrypt needs 128 * N * r bytes; give headroom over Node's 32MB default.
const MAXMEM = 128 * N * R * 2;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

// Small deny-list of passwords that satisfy the length rule but are trivially
// guessable. Not a substitute for a breached-password service.
const COMMON = new Set([
  "password1234",
  "password12345",
  "123456789012",
  "qwertyuiop12",
  "administrator",
  "changemechangeme",
  "welcome12345",
  "portoperations",
]);

export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(plain, salt, KEY_LEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(plain: string, encoded: string | null | undefined): boolean {
  if (!encoded) return false;
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;
  const expected = Buffer.from(hashB64, "base64");
  if (expected.length === 0) return false;
  try {
    const actual = scryptSync(plain, Buffer.from(saltB64, "base64"), expected.length, {
      N: n,
      r,
      p,
      maxmem: 128 * n * r * 2,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** True when a stored hash uses weaker parameters than the current ones. */
export function needsRehash(encoded: string): boolean {
  const parts = encoded.split("$");
  return parts[0] !== "scrypt" || Number(parts[1]) < N || Number(parts[2]) < R;
}

/** Returns null when acceptable, otherwise a user-facing reason. */
export function passwordPolicyError(plain: string, context: { email?: string } = {}): string | null {
  if (plain.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (plain.length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  const lower = plain.toLowerCase();
  if (COMMON.has(lower)) return "Password is too common.";
  if (new Set(plain).size < 5) return "Password is too repetitive.";
  const local = context.email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) {
    return "Password must not contain your email name.";
  }
  return null;
}

// A precomputed hash used to equalize timing when the account doesn't exist,
// so response time doesn't reveal which emails are registered.
let dummyHash: string | null = null;
export function dummyVerify(plain: string): void {
  dummyHash ??= hashPassword("timing-equalizer-not-a-real-password");
  verifyPassword(plain, dummyHash);
}
