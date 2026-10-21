// GET /api/imports/template — example appointments CSV with every column.

import { NextRequest, NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth";
import { APPOINTMENT_TEMPLATE_CSV } from "@/lib/importer";
import { handleRouteError } from "@/lib/route-helpers";

export async function GET(req: NextRequest): Promise<Response> {
  try {
    await requireApiRole(req, "supervisor");
    return new NextResponse(APPOINTMENT_TEMPLATE_CSV, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="appointments-template.csv"',
      },
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
