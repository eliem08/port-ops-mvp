// GET /api/ready — readiness probe for load balancers / orchestrators.
// 200 when the database answers and the schema is at the version this build
// expects; 503 otherwise (so traffic is held back during a bad deploy).
// No auth and no sensitive detail in the body.

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { LATEST_SCHEMA_VERSION, schemaVersion } from "@/lib/db/run-migrations";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const db = getDb();
    db.prepare("SELECT 1").get();
    const version = schemaVersion(db);
    const ready = version === LATEST_SCHEMA_VERSION;
    return NextResponse.json(
      { status: ready ? "ready" : "migrations_pending", schema: version, expected: LATEST_SCHEMA_VERSION },
      { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } }
    );
  } catch (err) {
    logger.error("readiness check failed", { err });
    return NextResponse.json({ status: "database_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
