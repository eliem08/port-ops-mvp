// Middleware: cross-site request rejection and the signed-cookie fast path.

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { isCrossSiteMutation, middleware } from "./middleware";
import { FALLBACK_SECRET, SESSION_COOKIE } from "@/test-utils/sessions";

function req(method: string, path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://ops.example.com${path}`, { method, headers: { host: "ops.example.com", ...headers } });
}

describe("isCrossSiteMutation", () => {
  it("never flags safe methods", () => {
    expect(isCrossSiteMutation(req("GET", "/api/x", { origin: "https://evil.example" }))).toBe(false);
  });
  it("allows same-origin mutations", () => {
    expect(isCrossSiteMutation(req("POST", "/api/x", { origin: "http://ops.example.com" }))).toBe(false);
  });
  it("blocks foreign and opaque origins", () => {
    expect(isCrossSiteMutation(req("POST", "/api/x", { origin: "https://evil.example" }))).toBe(true);
    expect(isCrossSiteMutation(req("DELETE", "/api/x", { origin: "null" }))).toBe(true);
  });
  it("falls back to Sec-Fetch-Site when Origin is absent", () => {
    expect(isCrossSiteMutation(req("POST", "/api/x", { "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(isCrossSiteMutation(req("POST", "/api/x", { "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(isCrossSiteMutation(req("POST", "/api/x"))).toBe(false); // non-browser client
  });
});

describe("middleware", () => {
  it("403s a cross-site API mutation before anything else", async () => {
    const res = await middleware(req("POST", "/api/auth/login", { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("cross_site_request");
  });

  it("redirects page visits without a session to /login, keeping the target", async () => {
    const res = await middleware(req("GET", "/appointments"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://ops.example.com/login?next=%2Fappointments");
  });

  it("401s API calls without a session; public endpoints pass", async () => {
    expect((await middleware(req("GET", "/api/appointments"))).status).toBe(401);
    expect((await middleware(req("GET", "/api/health"))).status).toBe(200);
  });

  it("lets a signed session cookie through (DB checks happen downstream)", async () => {
    const token = await new SignJWT({ sid: "s-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("u-1")
      .setExpirationTime("1h")
      .sign(FALLBACK_SECRET);
    const res = await middleware(req("GET", "/appointments", { cookie: `${SESSION_COOKIE}=${token}` }));
    expect(res.status).toBe(200);
  });

  it("rejects old-format tokens without a session id", async () => {
    const legacy = await new SignJWT({ userId: "demo-admin", role: "administrator" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(FALLBACK_SECRET);
    const res = await middleware(req("GET", "/api/appointments", { cookie: `${SESSION_COOKIE}=${legacy}` }));
    expect(res.status).toBe(401);
  });
});
