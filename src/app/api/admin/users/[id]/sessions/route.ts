// DELETE /api/admin/users/[id]/sessions — force sign-out of every session
// of the user (administrator).

import { NextRequest } from "next/server";
import { requireApiRole } from "@/lib/auth";
import { revokeSessionsByAdmin } from "@/lib/accounts";
import { getDb } from "@/lib/db/client";
import { handleRouteError, ok } from "@/lib/route-helpers";

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole(req, "administrator");
    const { id } = await ctx.params;
    return ok({ revoked: revokeSessionsByAdmin(getDb(), session.userId, id) });
  } catch (err) {
    return handleRouteError(err);
  }
}
