// Edge middleware — first line of defense; NOT the authoritative auth check.
// 1. Cross-site request forgery: state-changing /api requests whose Origin
//    (or Sec-Fetch-Site) shows a different site are rejected outright.
// 2. Fast reject: requests without a validly SIGNED session cookie go to
//    /login (pages) or get 401 (API). Revocation/expiry/disabled-user checks
//    need SQLite and happen in getSession() (layout, routes, actions).
// 3. Forwards the request path as x-pathname so the root layout can apply
//    the authoritative page guard.
// The secret comes from src/lib/auth-secret.ts (no Node-only imports).

import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { getSecretBytes } from "./lib/auth-secret";

const COOKIE_NAME = "portops_session";
const secret = getSecretBytes();

const PUBLIC_PREFIXES = ["/login", "/api/auth", "/api/health", "/api/ready", "/api/metrics"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

async function hasValidSession(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    return typeof payload.sid === "string";
  } catch {
    return false;
  }
}

function allowedOrigins(req: NextRequest): Set<string> {
  const hosts = new Set<string>();
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host) hosts.add(host.toLowerCase());
  hosts.add(req.nextUrl.host.toLowerCase());
  for (const o of (process.env.APP_ALLOWED_ORIGINS ?? "").split(",")) {
    const trimmed = o.trim();
    if (!trimmed) continue;
    try {
      hosts.add(new URL(trimmed).host.toLowerCase());
    } catch {
      // ignore malformed entries
    }
  }
  return hosts;
}

/** True when a state-changing request demonstrably comes from another site. */
export function isCrossSiteMutation(req: NextRequest): boolean {
  if (SAFE_METHODS.has(req.method)) return false;
  const origin = req.headers.get("origin");
  if (origin) {
    if (origin === "null") return true;
    try {
      return !allowedOrigins(req).has(new URL(origin).host.toLowerCase());
    } catch {
      return true;
    }
  }
  // No Origin (older browsers / non-browser clients): fall back to Fetch Metadata.
  return req.headers.get("sec-fetch-site") === "cross-site";
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/api/") && isCrossSiteMutation(req)) {
    return NextResponse.json(
      { error: { code: "cross_site_request", message: "Cross-site requests are not allowed." } },
      { status: 403 }
    );
  }

  const headers = new Headers(req.headers);
  headers.set("x-pathname", pathname);
  const pass = () => NextResponse.next({ request: { headers } });

  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return pass();
  }
  if (await hasValidSession(req)) return pass();

  // Fail closed: API callers get JSON, page visitors get redirected to /login.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "Sign-in required." } },
      { status: 401 }
    );
  }
  const loginUrl = new URL("/login", req.url);
  if (pathname !== "/") loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
