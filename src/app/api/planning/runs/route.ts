// POST /api/planning/runs — run a berth allocation solver and persist the run.
//   201 on create, 200 on idempotent replay (same content + solver).
// GET  /api/planning/runs — list plan runs, newest first.

import { NextRequest, NextResponse } from "next/server";
import { requireApiRole, jsonError } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { audit } from "@/lib/audit";
import {
  readJsonLimited,
  handleRouteError,
  ok,
} from "@/lib/route-helpers";
import {
  createPlanRun,
  listPlanRuns,
  PlanningInputError,
} from "@/lib/planning";
import { CreatePlanInput } from "@/contracts";

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const session = await requireApiRole(req, "planner");
    const body = await readJsonLimited(req);

    const parsed = CreatePlanInput.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            code: "validation_error",
            message: "Invalid plan input.",
            details: parsed.error.issues,
          },
        },
        { status: 400 }
      );
    }

    const input = parsed.data;
    let result: ReturnType<typeof createPlanRun>;
    try {
      result = createPlanRun(getDb(), session.userId, input);
    } catch (err) {
      if (err instanceof PlanningInputError) {
        return jsonError(400, "invalid_plan_input", err.message);
      }
      throw err;
    }
    const { record, created } = result;

    audit(session.userId, "planning.run_created", "berth_plan", record.id, {
      solverRequested: record.solverRequested,
      solverUsed: record.solverUsed,
      provenOptimal: record.provenOptimal,
      idempotentReplay: !created,
    });
    return ok(record, created ? 201 : 200);
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  try {
    await requireApiRole(req, "operations_viewer");
    return ok(listPlanRuns(getDb()));
  } catch (err) {
    return handleRouteError(err);
  }
}
