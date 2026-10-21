// GET /api/admin/audit/export?<same filters> — CSV download of the audit
// trail (administrator). The export itself is audited.

import { NextRequest, NextResponse } from "next/server";
import { requireApiRole, jsonError } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { AuditFilter, exportAuditCsv } from "@/lib/audit-query";
import { getDb } from "@/lib/db/client";
import { handleRouteError } from "@/lib/route-helpers";

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const session = await requireApiRole(req, "administrator");
    const parsed = AuditFilter.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!parsed.success) return jsonError(400, "validation_error", "Invalid audit filter.");
    const { csv, count } = exportAuditCsv(getDb(), parsed.data);
    audit(session.userId, "audit.exported", "audit_events", "export", {
      rows: count,
      action: parsed.data.action ?? null,
      from: parsed.data.from ?? null,
      to: parsed.data.to ?? null,
    });
    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="audit-${stamp}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
