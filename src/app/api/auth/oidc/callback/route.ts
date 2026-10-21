// GET /api/auth/oidc/callback — IdP redirect target. Validates state, swaps
// the code (with the PKCE verifier) for an ID token, verifies it, provisions
// the local account and starts a session. Failures land on /login?error=…

import { NextRequest, NextResponse } from "next/server";
import { createSession, sessionCookieOptions, setSessionCookie, verifyPurposeToken } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getDb } from "@/lib/db/client";
import { DomainError } from "@/lib/errors";
import { discover, exchangeCode, oidcConfig, OIDC_STATE_COOKIE, provisionSsoUser, verifyIdToken } from "@/lib/oidc";
import { clientIp } from "@/lib/rate-limit";
import { safeNextPath } from "@/lib/safe-redirect";

function fail(req: NextRequest, code: string): NextResponse {
  const url = new URL("/login", req.url);
  url.searchParams.set("error", code);
  const res = NextResponse.redirect(url);
  res.cookies.set(OIDC_STATE_COOKIE, "", sessionCookieOptions(0));
  return res;
}

export async function GET(req: NextRequest): Promise<Response> {
  const cfg = oidcConfig();
  if (!cfg) return fail(req, "sso_not_configured");
  const params = req.nextUrl.searchParams;
  if (params.get("error")) return fail(req, "sso_denied");

  const cookie = req.cookies.get(OIDC_STATE_COOKIE)?.value;
  const stored = cookie ? await verifyPurposeToken(cookie, "oidc") : null;
  const code = params.get("code");
  if (!stored || !code || typeof stored.state !== "string" || stored.state !== params.get("state")) {
    return fail(req, "sso_state_mismatch");
  }

  try {
    const disco = await discover(cfg.issuer);
    const idToken = await exchangeCode(cfg, disco, code, String(stored.verifier));
    const claims = await verifyIdToken(cfg, disco, idToken, String(stored.nonce));
    const userId = provisionSsoUser(getDb(), cfg, claims);
    const token = await createSession(userId, {
      authMethod: "oidc",
      ip: clientIp(req),
      userAgent: req.headers.get("user-agent"),
    });
    audit(userId, "auth.login", "user", userId, { method: "oidc" });
    const res = NextResponse.redirect(new URL(safeNextPath(String(stored.next ?? "/")), req.url));
    setSessionCookie(res, token);
    res.cookies.set(OIDC_STATE_COOKIE, "", sessionCookieOptions(0));
    return res;
  } catch (err) {
    if (!(err instanceof DomainError)) console.error("[oidc] callback failed:", err);
    return fail(req, err instanceof DomainError ? err.code : "sso_failed");
  }
}
