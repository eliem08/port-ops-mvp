// GET /api/simulate/runs/[id] — one simulation run with its KPIs.

import { NextRequest } from "next/server";
import { requireApiRole, jsonError } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { handleRouteError, ok } from "@/lib/route-helpers";
import { getSimulationRun } from "@/lib/simulation";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    await requireApiRole(req, "operations_viewer");
    const { id } = await ctx.params;

    const run = getSimulationRun(getDb(), id);
    if (!run) {
      return jsonError(404, "simulation_run_not_found", "Simulation run not found.");
    }
    return ok(run);
  } catch (err) {
    return handleRouteError(err);
  }
}
