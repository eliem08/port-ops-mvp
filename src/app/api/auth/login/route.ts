// Demo login: accepts { userId }, validates against demo_users,
// creates a signed session cookie. Demo only — no passwords.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSession, setSessionCookie, jsonError } from "@/lib/auth";
import { audit } from "@/lib/audit";

const LoginInput = z.object({ userId: z.string().min(1).max(64) }).strict();

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_request", "Request body must be JSON.");
  }
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
}
