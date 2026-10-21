// GET /api/auth/oidc/login — starts single sign-on: stores state/nonce/PKCE
// verifier in a signed short-lived cookie and redirects to the IdP.

import { NextRequest, NextResponse } from "next/server";
import { jsonError, sessionCookieOptions, signPurposeToken } from "@/lib/auth";
import { authorizationUrl, discover, newAuthRequest, oidcConfig, OIDC_STATE_COOKIE, OIDC_STATE_TTL_SECONDS } from "@/lib/oidc";
import { handleRouteError } from "@/lib/route-helpers";
import { safeNextPath } from "@/lib/safe-redirect";

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const cfg = oidcConfig();
    if (!cfg) return jsonError(404, "sso_not_configured", "Single sign-on is not configured.");
    const disco = await discover(cfg.issuer);
    const authReq = newAuthRequest();
    const next = safeNextPath(req.nextUrl.searchParams.get("next"));
    const stateToken = await signPurposeToken(
      "oidc",
      { state: authReq.state, nonce: authReq.nonce, verifier: authReq.verifier, next },
      OIDC_STATE_TTL_SECONDS
    );
    const res = NextResponse.redirect(authorizationUrl(cfg, disco, authReq));
    res.cookies.set(OIDC_STATE_COOKIE, stateToken, sessionCookieOptions(OIDC_STATE_TTL_SECONDS));
    return res;
  } catch (err) {
    return handleRouteError(err);
  }
}
