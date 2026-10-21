// GET /api/admin/audit?action=&actor=&entity=&from=&to=&page= — filtered,
// paginated audit trail (administrator).

import { NextRequest } from "next/server";
import { requireApiRole, jsonError } from "@/lib/auth";
import { AuditFilter, queryAudit } from "@/lib/audit-query";
import { getDb } from "@/lib/db/client";
import { handleRouteError, ok } from "@/lib/route-helpers";

export async function GET(req: NextRequest): Promise<Response> {
  try {
    await requireApiRole(req, "administrator");
    const parsed = AuditFilter.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!parsed.success) return jsonError(400, "validation_error", "Invalid audit filter.");
    return ok(queryAudit(getDb(), parsed.data));
  } catch (err) {
    return handleRouteError(err);
  }
}
