// POST /api/account/mfa — authenticator-app (TOTP) management.
//   { action: "begin" }                 → { secret, otpauthUrl } (MFA still off)
//   { action: "confirm", code }         → enables MFA once a valid code is shown
//   { action: "disable", password }     → turns MFA off (refused if the role requires it)
// Allowed for restricted sessions so required enrollment can be completed.

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireApiRole, jsonError, mfaRequiredForRole } from "@/lib/auth";
import { beginMfaEnrollment, confirmMfaEnrollment, disableOwnMfa } from "@/lib/accounts";
import { getDb } from "@/lib/db/client";
import { handleRouteError, ok, readJsonLimited } from "@/lib/route-helpers";

const MfaAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("begin") }).strict(),
  z.object({ action: z.literal("confirm"), code: z.string().min(6).max(10) }).strict(),
  z.object({ action: z.literal("disable"), password: z.string().min(1).max(256) }).strict(),
]);

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const session = await requireApiRole(req, "operations_viewer", { allowRestricted: true });
    if (session.authMethod === "oidc") {
      return jsonError(400, "sso_account", "MFA for single sign-on accounts is managed by your identity provider.");
    }
    const parsed = MfaAction.safeParse(await readJsonLimited(req));
    if (!parsed.success) return jsonError(400, "bad_request", "Unknown or malformed MFA action.");
    const db = getDb();
    switch (parsed.data.action) {
      case "begin":
        return ok(beginMfaEnrollment(db, session.userId));
      case "confirm":
        confirmMfaEnrollment(db, session.userId, parsed.data.code);
        return ok({ ok: true, mfaEnabled: true });
      case "disable":
        disableOwnMfa(db, session.userId, parsed.data.password, session.role, mfaRequiredForRole(session.role));
        return ok({ ok: true, mfaEnabled: false });
    }
  } catch (err) {
    return handleRouteError(err);
  }
}
