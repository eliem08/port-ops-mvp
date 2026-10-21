// Logout: revokes the server-side session (so a copied cookie stops working
// immediately) and clears the cookie.

import { NextResponse } from "next/server";
import { clearSession, clearSessionCookie, getSession, revokeSession } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getDb } from "@/lib/db/client";

export async function POST() {
  const session = await getSession();
  if (session) {
    revokeSession(getDb(), session.sessionId);
    audit(session.userId, "auth.logout", "user", session.userId, {});
  }
  await clearSession();
  const res = NextResponse.json({ ok: true });
  // Ensure the browser drops the cookie even if jar.delete behaved differently.
  clearSessionCookie(res);
  return res;
}
