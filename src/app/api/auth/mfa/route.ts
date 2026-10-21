// Second sign-in step for MFA accounts: { challenge, code }.
// The challenge is a 5-minute signed token from POST /api/auth/login proving
// the password step passed. Wrong codes count toward the account lockout.

import { NextRequest, NextResponse } from "next/server";
import { MfaVerifyInput } from "@/contracts";
import { createSession, setSessionCookie, jsonError, verifyPurposeToken } from "@/lib/auth";
import { verifyLoginTotp } from "@/lib/accounts";
import { audit } from "@/lib/audit";
import { getDb } from "@/lib/db/client";
import { readJsonLimited, handleRouteError } from "@/lib/route-helpers";
import { loginRateLimiter, clientIp, rateLimitExceeded } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  try {
    const ip = clientIp(req);
    const rl = loginRateLimiter.check(ip);
    if (!rl.allowed) {
      return rateLimitExceeded(rl.retryAfterSec, "Too many login attempts. Please try again shortly.");
    }
    const parsed = MfaVerifyInput.safeParse(await readJsonLimited(req));
    if (!parsed.success) return jsonError(400, "bad_request", "Expected { challenge, code }.");

    const claims = await verifyPurposeToken(parsed.data.challenge, "mfa");
    if (!claims || typeof claims.sub !== "string") {
      return jsonError(401, "challenge_expired", "Your sign-in attempt expired. Enter your password again.");
    }
    const result = verifyLoginTotp(getDb(), claims.sub, parsed.data.code);
    if (result.kind === "locked") {
      return jsonError(423, "account_locked", "Too many failed attempts. This account is temporarily locked.");
    }
    if (result.kind !== "ok") return jsonError(401, "invalid_code", "Invalid authentication code.");

    const token = await createSession(result.userId, {
      authMethod: "password+totp",
      ip,
      userAgent: req.headers.get("user-agent"),
    });
    audit(result.userId, "auth.login", "user", result.userId, { method: "password+totp" });
    const res = NextResponse.json({ ok: true });
    setSessionCookie(res, token);
    return res;
  } catch (err) {
    return handleRouteError(err);
  }
}
