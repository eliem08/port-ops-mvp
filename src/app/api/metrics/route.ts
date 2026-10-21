// GET /api/metrics — Prometheus scrape endpoint.
// Requires "Authorization: Bearer $METRICS_TOKEN"; disabled (404) when
// METRICS_TOKEN is unset. Token compared in constant time.

import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { getDb } from "@/lib/db/client";
import { collectMetrics } from "@/lib/metrics";

export const dynamic = "force-dynamic";

const digest = (s: string) => createHash("sha256").update(s).digest();

export async function GET(req: NextRequest): Promise<Response> {
  const token = process.env.METRICS_TOKEN;
  if (!token) return new NextResponse("Not found", { status: 404 });
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!timingSafeEqual(digest(given), digest(token))) {
    return new NextResponse("Unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
  }
  const file = process.env.DATABASE_URL?.replace("file:", "") ?? "./dev.db";
  const body = collectMetrics(getDb(), path.isAbsolute(file) ? file : path.join(process.cwd(), file));
  return new NextResponse(body, {
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" },
  });
}
