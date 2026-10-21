// Current session, or 401.

import { NextResponse } from "next/server";
import { getSession, jsonError } from "@/lib/auth";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return jsonError(401, "unauthenticated", "Sign-in required.");
  }
  return NextResponse.json({ user: session });
}
