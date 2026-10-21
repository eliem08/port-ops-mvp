// Password login: { email, password }.
// - Rate limited per IP before any work (10/min).
// - Generic 401 for unknown email / wrong password / disabled account (no
//   account enumeration); 423 while the account is temporarily locked.
// - When the account has MFA, responds { mfaRequired: true, challenge } and
//   the client completes sign-in at POST /api/auth/mfa.

import { NextRequest, NextResponse } from "next/server";
import { LoginInput } from "@/contracts";
import { createSession, setSessionCookie, jsonError, signPurposeToken } from "@/lib/auth";
import { authenticatePassword } from "@/lib/accounts";
import { audit } from "@/lib/audit";
import { getDb } from "@/lib/db/client";
import { readJsonLimited, handleRouteError } from "@/lib/route-helpers";
import { loginRateLimiter, clientIp, rateLimitExceeded } from "@/lib/rate-limit";

const MFA_CHALLENGE_TTL_SECONDS = 300;

export async function POST(req: NextRequest) {
  try {
    // Rate limit BEFORE parsing the body: brute-force protection.
    const ip = clientIp(req);
    const rl = loginRateLimiter.check(ip);
    if (!rl.allowed) {
      return rateLimitExceeded(rl.retryAfterSec, "Too many login attempts. Please try again shortly.");
    }

    const body = await readJsonLimited(req); // 1MB cap + valid-JSON guard
    const parsed = LoginInput.safeParse(body);
    if (!parsed.success) {
      return jsonError(400, "bad_request", "Expected { email, password }.");
    }

    const db = getDb();
    const result = authenticatePassword(db, parsed.data.email, parsed.data.password);
    switch (result.kind) {
      case "invalid":
        return jsonError(401, "invalid_credentials", "Invalid email or password.");
      case "locked":
        return jsonError(
          423,
          "account_locked",
          "Too many failed attempts. This account is temporarily locked — try again later or contact an administrator."
        );
      case "mfa_required": {
        const challenge = await signPurposeToken("mfa", { sub: result.userId }, MFA_CHALLENGE_TTL_SECONDS);
        return NextResponse.json({ mfaRequired: true, challenge });
      }
      case "ok": {
        const token = await createSession(result.userId, {
          authMethod: "password",
          ip,
          userAgent: req.headers.get("user-agent"),
        });
        audit(result.userId, "auth.login", "user", result.userId, { method: "password" });
        const res = NextResponse.json({ ok: true });
        setSessionCookie(res, token);
        return res;
      }
    }
  } catch (err) {
    return handleRouteError(err); // passes thrown Responses (413/400) through
  }
}
