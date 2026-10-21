// GET   /api/admin/settings — current operating policy (administrator).
// PATCH /api/admin/settings — change policy; every change is audited.

import { NextRequest } from "next/server";
import { requireApiRole, jsonError } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { handleRouteError, ok, readJsonLimited } from "@/lib/route-helpers";
import { getSettings, SettingsPatch, updateSettings } from "@/lib/settings";

export async function GET(req: NextRequest): Promise<Response> {
  try {
    await requireApiRole(req, "administrator");
    return ok({ settings: getSettings(getDb()) });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function PATCH(req: NextRequest): Promise<Response> {
  try {
    const session = await requireApiRole(req, "administrator");
    const parsed = SettingsPatch.safeParse(await readJsonLimited(req));
    if (!parsed.success) {
      return jsonError(400, "validation_error", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    return ok({ settings: updateSettings(getDb(), session.userId, parsed.data) });
  } catch (err) {
    return handleRouteError(err);
  }
}
