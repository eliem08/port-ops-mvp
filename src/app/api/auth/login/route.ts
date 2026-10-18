// Demo login: accepts { userId }, validates against demo_users,
// creates a signed session cookie. Demo only — no passwords.
// Brute-force note: login identities are PUBLIC (listed on the login
// page), so user enumeration is not a concern here; the rate limiter
// below throttles automated probing all the same.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSession, setSessionCookie, jsonError } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { readJsonLimited, handleRouteError } from "@/lib/route-helpers";
import { loginRateLimiter, clientIp, rateLimitExceeded } from "@/lib/rate-limit";

const LoginInput = z.object({ userId: z.string().min(1).max(64) }).strict();

export async function POST(req: NextRequest) {
  try {
    // Rate limit BEFORE parsing the body: brute-force protection.
    const ip = clientIp(req);
    const rl = loginRateLimiter.check(ip);
    if (!rl.allowed) {
      return rateLimitExceeded(
        rl.retryAfterSec,
        "Too many login attempts. Please try again shortly."
      );
    }

    const body = await readJsonLimited(req); // 1MB cap + valid-JSON guard

    const parsed = LoginInput.safeParse(body);
    if (!parsed.success) {
      return jsonError(400, "bad_request", "Expected { userId }.");
    }

    try {
      const token = await createSession(parsed.data.userId);
      audit(parsed.data.userId, "auth.login", "demo_user", parsed.data.userId, {
        synthetic: true,
      });
      const res = NextResponse.json({ ok: true });
      setSessionCookie(res, token);
      return res;
    } catch {
      return jsonError(401, "unknown_demo_user", "Unknown demo user id.");
    }
  } catch (err) {
    return handleRouteError(err); // passes thrown Responses (413/400) through
  }
}
