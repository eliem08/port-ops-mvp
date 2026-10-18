// Tests for src/lib/auth-secret.ts — the demo-auth secret contract:
// production without DEMO_AUTH_SECRET must THROW (refuse to run);
// dev/test without it warns once and uses the fallback.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

async function loadSecretModule() {
  const mod = await import("@/lib/auth-secret");
  mod.__resetSecretWarningForTests();
  return mod;
}

describe("auth-secret", () => {
  it("throws in production when DEMO_AUTH_SECRET is unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.DEMO_AUTH_SECRET;
    const mod = await loadSecretModule();
    expect(() => mod.getSecretBytes()).toThrow(/DEMO_AUTH_SECRET/);
  });

  it("does NOT throw during `next build` (NEXT_PHASE=phase-production-build)", async () => {
    // Builds run as NODE_ENV=production but never serve traffic — the
    // refusal must wait for server startup, not break the build.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    delete process.env.DEMO_AUTH_SECRET;
    const mod = await loadSecretModule();
    expect(() => mod.getSecretBytes()).not.toThrow();
  });

  it("rejects publicly known placeholder secrets in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const bad of [
      "dev-only-change-me-in-production",
      "dev-secret-change-me-in-production",
      "change-me-in-production",
    ]) {
      vi.stubEnv("DEMO_AUTH_SECRET", bad);
      vi.resetModules();
      const mod = await loadSecretModule();
      expect(() => mod.getSecretBytes()).toThrow(/publicly known placeholder/);
    }
  });

  it("rejects short secrets in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_AUTH_SECRET", "too-short");
    const mod = await loadSecretModule();
    expect(() => mod.getSecretBytes()).toThrow(/shorter than 32/);
  });

  it("returns the configured secret in production when set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_AUTH_SECRET", "test-secret-32-bytes-xxxxxxxxxxxxxxxx");
    const mod = await loadSecretModule();
    expect(new TextDecoder().decode(mod.getSecretBytes())).toBe(
      "test-secret-32-bytes-xxxxxxxxxxxxxxxx"
    );
  });

  it("warns (once) and falls back in non-production when unset", async () => {
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.DEMO_AUTH_SECRET;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await loadSecretModule();
    const first = mod.getSecretBytes();
    const second = mod.getSecretBytes();
    expect(new TextDecoder().decode(first)).toBe("dev-only-change-me-in-production");
    expect(new TextDecoder().decode(second)).toBe("dev-only-change-me-in-production");
    expect(warn).toHaveBeenCalledTimes(1); // warned exactly once
    warn.mockRestore();
  });

  it("prefers DEMO_AUTH_SECRET over the fallback in dev when set", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEMO_AUTH_SECRET", "dev-custom-secret");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await loadSecretModule();
    expect(new TextDecoder().decode(mod.getSecretBytes())).toBe("dev-custom-secret");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
