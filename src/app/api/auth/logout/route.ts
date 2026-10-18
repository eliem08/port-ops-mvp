// Demo logout: clears the session cookie.

import { NextResponse } from "next/server";
import { clearSession, getSession } from "@/lib/auth";
import { audit } from "@/lib/audit";

export async function POST() {
  const session = await getSession();
  if (session) {
    audit(session.userId, "auth.logout", "demo_user", session.userId, {
      synthetic: true,
    });
  }
  await clearSession();
  const res = NextResponse.json({ ok: true });
  // Ensure the browser drops the cookie even if jar.delete behaved differently.
  // Flags must MIRROR setSessionCookie — a Secure cookie set in production
  // is NOT cleared by a deletion response that omits `secure: true`.
  res.cookies.set("portops_demo_session", "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return res;
}
