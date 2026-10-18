// POST /api/simulate/runs — run a PortTwin scenario (atomic idempotency).
// GET  /api/simulate/runs — list simulation runs, newest first.

import { NextRequest, NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { audit } from "@/lib/audit";
import {
  readJsonLimited,
  handleRouteError,
  ok,
} from "@/lib/route-helpers";
import {
  createSimulationRun,
  listSimulationRuns,
  SimulationValidationError,
} from "@/lib/simulation";
import { CreateSimulationInput } from "@/contracts";

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const session = await requireApiRole(req, "planner");
    const body = await readJsonLimited(req);

    const parsed = CreateSimulationInput.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            code: "validation_error",
            message: "Invalid simulation input.",
            details: parsed.error.issues,
          },
        },
        { status: 400 }
      );
    }

    let result;
    try {
      result = createSimulationRun(getDb(), session.userId, parsed.data);
    } catch (err) {
      if (err instanceof SimulationValidationError) {
        // Vendored SimError mapped to a 400 with its public message.
        return NextResponse.json(
          {
            error: {
              code: "simulation_validation_error",
              message: err.publicError.message,
            },
          },
          { status: 400 }
        );
      }
      throw err;
    }

    audit(session.userId, "simulation.run_created", "simulation", result.record.id, {
      scenarioId: result.record.scenarioId,
      idempotentReplay: !result.created,
    });
    return ok(
      { ...result.record, created: result.created },
      result.created ? 201 : 200
    );
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  try {
    await requireApiRole(req, "operations_viewer");
    return ok(listSimulationRuns(getDb()));
  } catch (err) {
    return handleRouteError(err);
  }
}
