// PATCH /api/admin/users/[id] — administrator account changes:
// { label?, role?, disabled?, unlock?, resetPassword?, resetMfa? }.
// Guards: no self-disable/self-demotion, at least one active administrator.
// Disabling, password reset and MFA reset revoke the user's sessions.

import { NextRequest } from "next/server";
import { UpdateUserInput } from "@/contracts";
import { requireApiRole, jsonError } from "@/lib/auth";
import { updateUser } from "@/lib/accounts";
import { getDb } from "@/lib/db/client";
import { handleRouteError, ok, readJsonLimited } from "@/lib/route-helpers";

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole(req, "administrator");
    const { id } = await ctx.params;
    const parsed = UpdateUserInput.safeParse(await readJsonLimited(req));
    if (!parsed.success) {
      return jsonError(400, "validation_error", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    return ok({ user: updateUser(getDb(), session.userId, id, parsed.data) });
  } catch (err) {
    return handleRouteError(err);
  }
}
