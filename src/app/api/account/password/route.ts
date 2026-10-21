// POST /api/account/password — change own password: { currentPassword, newPassword }.
// Allowed for restricted sessions (this is how a forced change is completed).
// Other sessions of the user are revoked; the current one stays signed in.

import { NextRequest } from "next/server";
import { ChangePasswordInput } from "@/contracts";
import { requireApiRole, jsonError } from "@/lib/auth";
import { changePassword } from "@/lib/accounts";
import { getDb } from "@/lib/db/client";
import { handleRouteError, ok, readJsonLimited } from "@/lib/route-helpers";

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const session = await requireApiRole(req, "operations_viewer", { allowRestricted: true });
    const parsed = ChangePasswordInput.safeParse(await readJsonLimited(req));
    if (!parsed.success) return jsonError(400, "bad_request", "Expected { currentPassword, newPassword }.");
    changePassword(getDb(), session.userId, parsed.data.currentPassword, parsed.data.newPassword, session.sessionId);
    return ok({ ok: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
