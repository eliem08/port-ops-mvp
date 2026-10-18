// GET /api/simulate/compare?a=<uuid>&b=<uuid> — side-by-side run comparison
// with a per-KPI delta table (delta = B − A).

import { NextRequest } from "next/server";
import { requireApiRole, jsonError } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { handleRouteError, ok } from "@/lib/route-helpers";
import { compareSimulationRuns, SimulationNotFoundError } from "@/lib/simulation";
import { EntityId } from "@/contracts";

export async function GET(req: NextRequest): Promise<Response> {
  try {
    await requireApiRole(req, "operations_viewer");

    const params = req.nextUrl.searchParams;
    const a = EntityId.safeParse(params.get("a"));
    const b = EntityId.safeParse(params.get("b"));
    if (!a.success || !b.success) {
      return jsonError(
        400,
        "invalid_compare_ids",
        "Query params 'a' and 'b' are required and must both be UUIDs."
      );
    }

    try {
      return ok(compareSimulationRuns(getDb(), a.data, b.data));
    } catch (err) {
      if (err instanceof SimulationNotFoundError) {
        return jsonError(404, "simulation_run_not_found", err.message);
      }
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}
