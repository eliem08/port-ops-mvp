// POST /api/imports/appointments?dryRun=1&filename=… — CSV body (text/csv,
// max 5 MB). Supervisor or administrator. A dry run validates and reports
// without writing; a commit imports all rows atomically or nothing.

import { NextRequest } from "next/server";
import { requireApiRole, jsonError } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { importAppointments, MAX_IMPORT_BYTES } from "@/lib/importer";
import { handleRouteError, ok } from "@/lib/route-helpers";

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const session = await requireApiRole(req, "supervisor");
    const len = Number(req.headers.get("content-length") ?? "0");
    if (len > MAX_IMPORT_BYTES) return jsonError(413, "file_too_large", "Import files are limited to 5 MB.");
    const text = await req.text();
    if (text.trim() === "") return jsonError(400, "empty_file", "The file is empty.");
    const params = req.nextUrl.searchParams;
    const report = importAppointments(getDb(), session.userId, text, {
      dryRun: params.get("dryRun") === "1" || params.get("dryRun") === "true",
      filename: params.get("filename"),
    });
    return ok(report, report.dryRun ? 200 : 201);
  } catch (err) {
    return handleRouteError(err);
  }
}
