// Auth guard for the demo UI.
// The JWT secret comes from src/lib/auth-secret.ts — the single source of
// truth shared with src/lib/auth.ts. auth-secret has no Node-only imports,
// so it is safe to use in the edge runtime. (Previously the fallback secret
// string was duplicated here; drift would have split-brained verification.)

import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { getSecretBytes } from "./lib/auth-secret";

const COOKIE_NAME = "portops_demo_session";
const secret = getSecretBytes();

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
