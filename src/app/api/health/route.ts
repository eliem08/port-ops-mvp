// GET /api/health — liveness probe. No auth, no DB, cheap.
// Use /api/ready for readiness (database reachable and migrated).

import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import path from "node:path";

let cachedVersion: string | null = null;
function getVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  let version = process.env.APP_VERSION ?? "0.0.0";
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8")
    );
    if (!process.env.APP_VERSION && typeof pkg.version === "string") version = pkg.version;
  } catch {
    // keep fallback
  }
  cachedVersion = version;
  return version;
}

export async function GET(): Promise<Response> {
  return NextResponse.json({
    status: "ok",
    service: "port-ops-mvp",
    version: getVersion(),
    commit: process.env.GIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
  });
}
