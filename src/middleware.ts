// Auth guard for the demo UI.
// Middleware cannot import node:sqlite, so the minimal JWT verification
// logic is duplicated here from src/lib/auth.ts (same secret, same cookie).

import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const COOKIE_NAME = "portops_demo_session";
const secret = new TextEncoder().encode(
  process.env.DEMO_AUTH_SECRET ?? "dev-only-change-me-in-production"
);

const PUBLIC_PREFIXES = ["/login", "/api/auth", "/api/health"];

async function hasValidSession(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) return false;
  try {
    await jwtVerify(token, secret);
    return true;
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }
  const ok = await hasValidSession(req);
  if (ok) return NextResponse.next();

  // Fail closed: API callers get JSON, page visitors get redirected to /login.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "Demo login required." } },
      { status: 401 }
    );
  }
  const loginUrl = new URL("/login", req.url);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
