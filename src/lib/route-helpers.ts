// Shared HTTP helpers for API routes.
// Every route must fail closed with the sanitized envelope
// { error: { code, message } } — never stack traces in responses.

import { NextRequest, NextResponse } from "next/server";
import type { DatabaseSync } from "node:sqlite";
import { jsonError } from "./auth";
import { DomainError } from "./errors";
import { logger } from "./logger";

export const MAX_BODY_BYTES = 1024 * 1024; // 1MB

/**
 * Read and JSON-parse the request body, rejecting payloads over 1MB.
 * Throws a Response (via jsonError) on oversize / empty / invalid bodies.
 */
export async function readJsonLimited(req: NextRequest): Promise<unknown> {
  const len = req.headers.get("content-length");
  if (len !== null && Number.isFinite(Number(len)) && Number(len) > MAX_BODY_BYTES) {
    throw jsonError(413, "payload_too_large", "Request body exceeds the 1MB limit.");
  }
  const text = await req.text();
  // text.length is chars, not bytes — conservative is fine for the guard.
  if (text.length > MAX_BODY_BYTES) {
    throw jsonError(413, "payload_too_large", "Request body exceeds the 1MB limit.");
  }
  if (text.trim() === "") {
    throw jsonError(400, "empty_body", "A JSON request body is required.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw jsonError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

/**
 * Route-level catch handler. Re-throws nothing:
 * - Responses thrown by requireApiRole/jsonError pass through unchanged.
 * - Everything else becomes a sanitized 500 envelope (server-side logged).
 */
export function handleRouteError(err: unknown): Response {
  if (err instanceof Response) return err;
  // Expected business-rule failures carry their own status and safe message.
  if (err instanceof DomainError) return jsonError(err.status, err.code, err.message);
  logger.error("unhandled API error", { err });
  return jsonError(500, "internal_error", "An unexpected error occurred.");
}

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

/**
 * Run fn inside a SQLite transaction. Synchronous and fail-closed:
 * any throw rolls back. This Node's node:sqlite has no built-in
 * db.transaction() helper, so BEGIN IMMEDIATE / COMMIT / ROLLBACK it is.
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  // Re-entrant: an inner call (e.g. createAppointment inside a bulk import)
  // becomes a SAVEPOINT of the outer transaction, so the outer unit stays
  // all-or-nothing.
  const depth = txDepth.get(db) ?? 0;
  const sp = `sp_${depth}`;
  db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
  txDepth.set(db, depth + 1);
  try {
    const result = fn();
    db.exec(depth === 0 ? "COMMIT" : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    try {
      db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    } catch {
      // already rolled back / never began — swallow, original error wins
    }
    throw err;
  } finally {
    txDepth.set(db, depth);
  }
}

const txDepth = new WeakMap<DatabaseSync, number>();
