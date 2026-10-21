// CSV import of truck appointments from terminal / TAS exports.
//
// Columns (header row required, case-insensitive, any order):
//   truck_plate*   container_no   driver_name   scheduled_at*   status   external_ref
// - scheduled_at: ISO 8601 UTC ("2026-11-02T08:30:00Z").
// - status: requested (default) or confirmed. Later states are produced by
//   the platform's own workflow, never imported.
// - container_no: ISO 6346 with a valid check digit when present.
// - external_ref: the source system's id. Re-importing the same ref is a
//   no-op (atomic idempotency key "import:<ref>"), so files can be re-sent.
//
// Every row is validated first; a commit writes all valid rows in one
// transaction (dryRun writes nothing). Invalid rows are reported, never
// silently "fixed".

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CreateAppointmentInput } from "@/contracts";
import { createAppointment, setAppointmentStatus } from "./appointments";
import { parseCsv } from "./csv";
import { DomainError } from "./errors";
import { withTransaction } from "./route-helpers";
import { isValidContainer } from "@/vendored/gatewatch/iso6346";

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 10_000;
const MAX_REPORTED_ERRORS = 200;

const COLUMNS = ["truck_plate", "container_no", "driver_name", "scheduled_at", "status", "external_ref"] as const;
const REQUIRED = ["truck_plate", "scheduled_at"] as const;

const ImportStatus = z.enum(["requested", "confirmed"]);

export interface RowError {
  row: number; // 1-based data row (header excluded); spreadsheet line = row + 1
  field: string | null;
  message: string;
}

export interface ImportReport {
  batchId: string | null;
  dryRun: boolean;
  rows: number;
  valid: number;
  created: number;
  skipped: number;
  errors: RowError[];
  errorCount: number;
}

interface ValidRow {
  row: number;
  input: z.infer<typeof CreateAppointmentInput>;
  status: "requested" | "confirmed";
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function validate(csvText: string): { rows: number; valid: ValidRow[]; errors: RowError[] } {
  let table: string[][];
  try {
    table = parseCsv(csvText);
  } catch (err) {
    throw new DomainError(400, "invalid_csv", (err as Error).message);
  }
  if (table.length === 0) throw new DomainError(400, "empty_file", "The file is empty.");
  const header = table[0].map(normalizeHeader);
  const unknown = header.filter((h) => h && !(COLUMNS as readonly string[]).includes(h));
  if (unknown.length) {
    throw new DomainError(400, "unknown_columns", `Unknown column(s): ${unknown.join(", ")}. Expected: ${COLUMNS.join(", ")}.`);
  }
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) throw new DomainError(400, "missing_columns", `Missing required column(s): ${missing.join(", ")}.`);
  const dataRows = table.slice(1);
  if (dataRows.length > MAX_IMPORT_ROWS) {
    throw new DomainError(413, "too_many_rows", `At most ${MAX_IMPORT_ROWS} rows per import (file has ${dataRows.length}).`);
  }

  const valid: ValidRow[] = [];
  const errors: RowError[] = [];
  const seenRefs = new Map<string, number>();
  dataRows.forEach((cells, i) => {
    const row = i + 1;
    const get = (col: string) => {
      const idx = header.indexOf(col);
      const v = idx === -1 ? "" : (cells[idx] ?? "").trim();
      return v === "" ? null : v;
    };
    const rowErrors: RowError[] = [];
    const containerNo = get("container_no")?.toUpperCase().replace(/\s+/g, "") ?? null;
    if (containerNo && !isValidContainer(containerNo)) {
      rowErrors.push({ row, field: "container_no", message: `'${containerNo}' is not a valid ISO 6346 container number.` });
    }
    const status = ImportStatus.safeParse(get("status") ?? "requested");
    if (!status.success) {
      rowErrors.push({ row, field: "status", message: "status must be 'requested' or 'confirmed'." });
    }
    const ref = get("external_ref");
    if (ref) {
      if (ref.length > 56) rowErrors.push({ row, field: "external_ref", message: "external_ref is longer than 56 characters." });
      const first = seenRefs.get(ref);
      if (first !== undefined) rowErrors.push({ row, field: "external_ref", message: `Duplicate external_ref (also on row ${first}).` });
      else seenRefs.set(ref, row);
    }
    const parsed = CreateAppointmentInput.safeParse({
      truckPlate: get("truck_plate")?.toUpperCase() ?? "",
      containerNo,
      driverName: get("driver_name"),
      scheduledAt: get("scheduled_at") ?? "",
      ...(ref ? { idempotencyKey: `import:${ref}` } : {}),
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = { truckPlate: "truck_plate", containerNo: "container_no", driverName: "driver_name", scheduledAt: "scheduled_at", idempotencyKey: "external_ref" }[String(issue.path[0])] ?? null;
        rowErrors.push({ row, field, message: issue.message });
      }
    }
    if (rowErrors.length) errors.push(...rowErrors);
    else valid.push({ row, input: parsed.data!, status: status.data! });
  });
  return { rows: dataRows.length, valid, errors };
}

export function importAppointments(
  db: DatabaseSync,
  actorId: string,
  csvText: string,
  opts: { dryRun: boolean; filename?: string | null }
): ImportReport {
  if (Buffer.byteLength(csvText, "utf8") > MAX_IMPORT_BYTES) {
    throw new DomainError(413, "file_too_large", "Import files are limited to 5 MB.");
  }
  const { rows, valid, errors } = validate(csvText);
  const report: ImportReport = {
    batchId: null,
    dryRun: opts.dryRun,
    rows,
    valid: valid.length,
    created: 0,
    skipped: 0,
    errors: errors.slice(0, MAX_REPORTED_ERRORS),
    errorCount: errors.length,
  };
  if (opts.dryRun) return report;
  // All-or-nothing on validation: a partially bad file is fixed and re-sent,
  // so the source of truth stays the operator's file.
  if (errors.length > 0) {
    throw new DomainError(422, "validation_failed", `${errors.length} row error(s) — run a dry run to see them; nothing was imported.`);
  }

  const batchId = randomUUID();
  withTransaction(db, () => {
    for (const v of valid) {
      const { created, record } = createAppointment(db, actorId, {
        truckPlate: v.input.truckPlate,
        containerNo: v.input.containerNo ?? null,
        driverName: v.input.driverName ?? null,
        scheduledAt: v.input.scheduledAt,
        idempotencyKey: v.input.idempotencyKey,
      });
      if (!created) {
        report.skipped++;
        continue;
      }
      report.created++;
      if (v.status === "confirmed") setAppointmentStatus(db, record.id, "confirmed");
    }
    db.prepare(
      `INSERT INTO import_batches (id, kind, filename, row_count, created_count, skipped_count, error_count, report_json, created_by)
       VALUES (?, 'appointments', ?, ?, ?, ?, 0, '[]', ?)`
    ).run(batchId, opts.filename?.slice(0, 200) ?? null, rows, report.created, report.skipped, actorId);
    db.prepare(
      `INSERT INTO audit_events (id, actor_id, action, entity, entity_id, detail_json)
       VALUES (?, ?, 'import.completed', 'import_batch', ?, ?)`
    ).run(randomUUID(), actorId, batchId, JSON.stringify({ kind: "appointments", rows, created: report.created, skipped: report.skipped }));
  });
  report.batchId = batchId;
  return report;
}

export interface ImportBatchSummary {
  id: string;
  kind: string;
  filename: string | null;
  rows: number;
  created: number;
  skipped: number;
  createdBy: string;
  createdAt: string;
}

export function listImportBatches(db: DatabaseSync, limit = 50): ImportBatchSummary[] {
  return (
    db
      .prepare(
        `SELECT b.id, b.kind, b.filename, b.row_count, b.created_count, b.skipped_count, b.created_at,
                COALESCE(u.label, b.created_by) AS who
         FROM import_batches b LEFT JOIN users u ON u.id = b.created_by
         ORDER BY b.created_at DESC LIMIT ?`
      )
      .all(limit) as Array<{
      id: string;
      kind: string;
      filename: string | null;
      row_count: number;
      created_count: number;
      skipped_count: number;
      created_at: string;
      who: string;
    }>
  ).map((b) => ({
    id: b.id,
    kind: b.kind,
    filename: b.filename,
    rows: b.row_count,
    created: b.created_count,
    skipped: b.skipped_count,
    createdBy: b.who,
    createdAt: b.created_at,
  }));
}

export const APPOINTMENT_TEMPLATE_CSV =
  "truck_plate,container_no,driver_name,scheduled_at,status,external_ref\r\n" +
  "12345-A-6,MSCU1234566,Driver Name,2026-11-02T08:30:00Z,confirmed,TAS-000123\r\n";
