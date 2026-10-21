// GET /api/imports — recent import batches (supervisor or administrator).

import { NextRequest } from "next/server";
import { requireApiRole } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { listImportBatches } from "@/lib/importer";
import { handleRouteError, ok } from "@/lib/route-helpers";

export async function GET(req: NextRequest): Promise<Response> {
  try {
    await requireApiRole(req, "supervisor");
    return ok({ batches: listImportBatches(getDb()) });
  } catch (err) {
    return handleRouteError(err);
  }
}
