// GET  /api/admin/users — list accounts (administrator).
// POST /api/admin/users — create an account: { email, label, role, password }.
// New accounts must change the initial password at first sign-in.

import { NextRequest } from "next/server";
import { CreateUserInput } from "@/contracts";
import { requireApiRole, jsonError } from "@/lib/auth";
import { createUser, listUsers } from "@/lib/accounts";
import { getDb } from "@/lib/db/client";
import { handleRouteError, ok, readJsonLimited } from "@/lib/route-helpers";

export async function GET(req: NextRequest): Promise<Response> {
  try {
    await requireApiRole(req, "administrator");
    return ok({ users: listUsers(getDb()) });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const session = await requireApiRole(req, "administrator");
    const parsed = CreateUserInput.safeParse(await readJsonLimited(req));
    if (!parsed.success) {
      return jsonError(400, "validation_error", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    return ok({ user: createUser(getDb(), session.userId, parsed.data) }, 201);
  } catch (err) {
    return handleRouteError(err);
  }
}
