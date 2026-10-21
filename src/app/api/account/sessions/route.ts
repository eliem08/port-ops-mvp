// GET    /api/account/sessions — own active sessions (current one flagged).
// DELETE /api/account/sessions — sign out every other device.

import { NextRequest } from "next/server";
import { requireApiRole, revokeUserSessions } from "@/lib/auth";
import { listActiveSessions } from "@/lib/accounts";
import { audit } from "@/lib/audit";
import { getDb } from "@/lib/db/client";
import { handleRouteError, ok } from "@/lib/route-helpers";

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const session = await requireApiRole(req, "operations_viewer", { allowRestricted: true });
    const sessions = listActiveSessions(getDb(), session.userId).map((s) => ({
      ...s,
      current: s.id === session.sessionId,
    }));
    return ok({ sessions });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(req: NextRequest): Promise<Response> {
  try {
    const session = await requireApiRole(req, "operations_viewer", { allowRestricted: true });
    const revoked = revokeUserSessions(getDb(), session.userId, session.sessionId);
    audit(session.userId, "auth.session_revoked", "user", session.userId, { count: revoked, scope: "others" });
    return ok({ revoked });
  } catch (err) {
    return handleRouteError(err);
  }
}
