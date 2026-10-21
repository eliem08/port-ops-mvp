// Unit tests for the security primitives: TOTP (RFC 6238 vectors), scrypt
// password hashing and policy, sealed secrets, and post-login redirects.

import { describe, it, expect } from "vitest";
import { base32Decode, base32Encode, generateTotpSecret, otpauthUrl, totpAt, verifyTotp } from "./totp";
import { hashPassword, needsRehash, passwordPolicyError, verifyPassword } from "./password";
import { open, seal } from "./crypto-box";
import { safeNextPath } from "./safe-redirect";

describe("TOTP", () => {
  // RFC 6238 Appendix B, SHA-1 seed "12345678901234567890" (8-digit codes
  // truncated to the 6 low digits that authenticator apps use).
  const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("matches the RFC 6238 vector at t=%i", (t, code) => {
    expect(totpAt(RFC_SECRET, t)).toBe(code);
  });

  it("base32 round-trips and generates 160-bit secrets", () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
    expect(base32Decode(base32Encode(Buffer.from("hello")))).toEqual(Buffer.from("hello"));
  });

  it("accepts ±1 step of clock drift, rejects 2 steps and malformed codes", () => {
    const now = 1_700_000_000;
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now), now)).toBe(true);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now - 30), now)).toBe(true);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now + 30), now)).toBe(true);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now - 90), now)).toBe(false);
    expect(verifyTotp(RFC_SECRET, "12345", now)).toBe(false);
    expect(verifyTotp(RFC_SECRET, "abcdef", now)).toBe(false);
  });

  it("builds an otpauth:// URL with issuer and account", () => {
    const url = otpauthUrl("JBSWY3DPEHPK3PXP", "omar@example.com", "Port Ops");
    expect(url).toMatch(/^otpauth:\/\/totp\/Port%20Ops%3Aomar%40example\.com\?/);
    expect(url).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(url).toContain("issuer=Port+Ops");
  });
});

describe("password hashing", () => {
  it("verifies the right password only; salts differ per hash", () => {
    const a = hashPassword("correct-horse-battery-staple");
    const b = hashPassword("correct-horse-battery-staple");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(verifyPassword("correct-horse-battery-staple", a)).toBe(true);
    expect(verifyPassword("correct-horse-battery-stapl", a)).toBe(false);
    expect(needsRehash(a)).toBe(false);
  });

  it("fails closed on missing or malformed hashes", () => {
    for (const bad of [null, undefined, "", "plaintext", "scrypt$x$8$1$aa$bb", "bcrypt$1$2$3$4$5"]) {
      expect(verifyPassword("anything", bad as string | null)).toBe(false);
    }
  });

  it("policy: length, common, repetitive, contains email name", () => {
    expect(passwordPolicyError("short")).toMatch(/at least 12/);
    expect(passwordPolicyError("password1234")).toMatch(/too common/);
    expect(passwordPolicyError("aaaaaaaaaaaaaaa")).toMatch(/repetitive/);
    expect(passwordPolicyError("omar.benali-2026!", { email: "omar.benali@example.com" })).toMatch(/email/);
    expect(passwordPolicyError("correct-horse-battery-staple")).toBeNull();
  });
});

describe("sealed secrets (AES-256-GCM)", () => {
  it("round-trips, uses a fresh IV, and detects tampering", () => {
    const a = seal("JBSWY3DPEHPK3PXP");
    const b = seal("JBSWY3DPEHPK3PXP");
    expect(a).not.toBe(b);
    expect(a.startsWith("v1.")).toBe(true);
    expect(open(a)).toBe("JBSWY3DPEHPK3PXP");
    const parts = a.split(".");
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith("AA") ? "BB" : "AA");
    expect(() => open(parts.join("."))).toThrow();
    expect(() => open("garbage")).toThrow();
  });
});

describe("safeNextPath", () => {
  it.each([
    ["/appointments?status=confirmed", "/appointments?status=confirmed"],
    ["//evil.example/phish", "/"],
    ["https://evil.example", "/"],
    ["/\\evil.example", "/"],
    ["/login", "/"],
    ["/api/admin/users", "/"],
    [null, "/"],
  ])("%s → %s", (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });
});
