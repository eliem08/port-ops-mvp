// TOTP (RFC 6238) for multi-factor authentication — compatible with
// Google Authenticator, Microsoft Authenticator, 1Password, Aegis, etc.
// HMAC-SHA1, 30s step, 6 digits (the parameters every authenticator app
// supports). Verification accepts ±1 step for clock skew and compares in
// constant time.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const STEP_SECONDS = 30;
const DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit random secret, base32-encoded (RFC 4226 recommended length). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpAt(secretB32: string, unixSeconds: number): string {
  const counter = Math.floor(unixSeconds / STEP_SECONDS);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(secretB32)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      (hmac[offset + 1] << 16) |
      (hmac[offset + 2] << 8) |
      hmac[offset + 3]) %
    10 ** DIGITS;
  return code.toString().padStart(DIGITS, "0");
}

export function verifyTotp(
  secretB32: string,
  code: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  const normalized = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  let ok = false;
  for (const drift of [-1, 0, 1]) {
    const expected = totpAt(secretB32, nowSeconds + drift * STEP_SECONDS);
    // No early exit: check every window so timing doesn't reveal which matched.
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))) ok = true;
  }
  return ok;
}

export function otpauthUrl(secretB32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
