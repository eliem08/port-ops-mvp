// GET /api/planning/runs/[id] — fetch one persisted plan run.

import { NextRequest } from "next/server";
import { requireApiRole, jsonError } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { handleRouteError, ok } from "@/lib/route-helpers";
import { getPlanRun } from "@/lib/planning";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    await requireApiRole(req, "operations_viewer");
    const { id } = await params;
    const record = getPlanRun(getDb(), id);
    if (!record) {
      return jsonError(404, "not_found", "Plan run not found.");
    }
    return ok(record);
  } catch (err) {
    return handleRouteError(err);
  }
}
