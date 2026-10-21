// Governance & data intake: gate policy (human in the loop), settings,
// CSV import/export, audit viewer/export and the audit forwarder.
// Mocked-auth route style (see route-harness.ts) on a fresh in-memory DB.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { NextRequest } from "next/server";
import { resetHarness, allowAs, denyWith, postJson, getReq, patchJson, OPERATOR, SUPERVISOR, ADMIN, VIEWER } from "@/test-utils/route-harness";

const mocks = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  getDb: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireApiRole: mocks.requireApiRole,
  jsonError: (status: number, code: string, message: string) =>
    new Response(JSON.stringify({ error: { code, message } }), { status }),
}));
vi.mock("@/lib/db/client", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));

import { POST as postScans } from "./gate/scans/route";
import { POST as postAppointments } from "./appointments/route";
import { PATCH as patchStatus } from "./appointments/[id]/status/route";
import { GET as exportAppointments } from "./appointments/export/route";
import { GET as getSettingsRoute, PATCH as patchSettingsRoute } from "./admin/settings/route";
import { GET as getAuditRoute } from "./admin/audit/route";
import { GET as exportAuditRoute } from "./admin/audit/export/route";
import { POST as importRoute } from "./imports/appointments/route";
import { GET as listImportsRoute } from "./imports/route";
import { applyGatePolicy, DEFAULT_SETTINGS, getSettings, updateSettings } from "@/lib/settings";
import { recordScanVerification } from "@/lib/demo-workflow";
import { importAppointments } from "@/lib/importer";
import { parseCsv, toCsv } from "@/lib/csv";
import { forwardAuditBatch } from "@/lib/audit-forwarder";
import { scanRateLimiter } from "@/lib/rate-limit";

let db: DatabaseSync;
beforeEach(() => {
  db = resetHarness(mocks);
  scanRateLimiter.reset();
});

const csvReq = (body: string, query = "") =>
  new NextRequest(`http://localhost/api/imports/appointments${query}`, {
    method: "POST",
    headers: { "content-type": "text/csv" },
    body,
  });

// ── Gate policy ──────────────────────────────────────────────────────────

describe("gate policy (human in the loop)", () => {
  it("defaults keep automatic acceptance at the vendored threshold", () => {
    expect(getSettings(db)).toEqual(DEFAULT_SETTINGS);
    expect(applyGatePolicy(DEFAULT_SETTINGS, 70)).toEqual({ outcome: "auto-accept", policyReason: null });
    expect(applyGatePolicy(DEFAULT_SETTINGS, Number.NaN).outcome).toBe("human-review");
  });

  async function confirmedAppointment(): Promise<string> {
    allowAs(mocks, OPERATOR);
    const created = await (
      await postAppointments(postJson("/api/appointments", { truckPlate: "CAS-4821-A", containerNo: "TCLU4829103", scheduledAt: "2026-10-20T10:00:00Z" }))
    ).json();
    await patchStatus(patchJson(`/api/appointments/${created.id}/status`, { to: "confirmed" }), { params: Promise.resolve({ id: created.id }) });
    return created.id;
  }
  const scan = (appointmentId: string, confidence: number) =>
    postScans(postJson("/api/gate/scans", { appointmentId, plateRead: "CAS-4821-A", containerRead: "TCLU4829103", confidence }));

  it("REST scan: a perfect match auto-accepts by default", async () => {
    const id = await confirmedAppointment();
    expect((await (await scan(id, 95)).json()).outcome).toBe("auto-accept");
  });

  it("REST scan: with automatic acceptance disabled, a perfect match goes to a supervisor", async () => {
    updateSettings(db, "admin", { "gate.autoAcceptEnabled": false });
    const id = await confirmedAppointment();
    const body = await (await scan(id, 99)).json();
    expect(body.outcome).toBe("human-review");
    expect(body.reason).toMatch(/automatic acceptance is disabled/);
    expect(db.prepare("SELECT status FROM appointments WHERE id = ?").get(id)).toEqual({ status: "confirmed" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM review_items").get()).toEqual({ n: 1 });
  });

  it("REST scan: a raised threshold routes mid-confidence scans to review", async () => {
    updateSettings(db, "admin", { "gate.reviewThreshold": 90 });
    const id = await confirmedAppointment();
    const body = await (await scan(id, 85)).json();
    expect(body.outcome).toBe("human-review");
    expect(body.reason).toMatch(/configured threshold \(90\)/);
  });

  it("UI workflow path applies the same policy", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    db.prepare(
      "INSERT INTO appointments (id, truck_plate, container_no, scheduled_at, status, created_by) VALUES (?, 'CAS-1-A', 'TCLU4829103', ?, 'confirmed', 'u')"
    ).run(id, new Date().toISOString());
    updateSettings(db, "admin", { "gate.autoAcceptEnabled": false });
    const r = await recordScanVerification(db, "u-op", { appointmentId: id, plateRead: "CAS-1-A", containerRead: "TCLU4829103", confidence: 99 });
    expect(r.outcome).toBe("human-review");
    expect(r.checkedIn).toBe(false);
    expect(r.note).toMatch(/disabled/);
  });
});

// ── Settings routes ──────────────────────────────────────────────────────

describe("/api/admin/settings", () => {
  it("administrators read and change policy; changes are audited with before/after", async () => {
    allowAs(mocks, ADMIN);
    expect((await (await getSettingsRoute(getReq("/api/admin/settings"))).json()).settings).toEqual(DEFAULT_SETTINGS);
    const res = await patchSettingsRoute(patchJson("/api/admin/settings", { "gate.autoAcceptEnabled": false }));
    expect((await res.json()).settings["gate.autoAcceptEnabled"]).toBe(false);
    const ev = db.prepare("SELECT action, entity_id, detail_json FROM audit_events WHERE action = 'settings.changed'").get() as Record<string, string>;
    expect(ev.entity_id).toBe("gate.autoAcceptEnabled");
    expect(JSON.parse(ev.detail_json)).toEqual({ from: "true", to: "false" });
  });

  it("rejects a threshold below the 70 floor and unknown keys", async () => {
    allowAs(mocks, ADMIN);
    expect((await patchSettingsRoute(patchJson("/api/admin/settings", { "gate.reviewThreshold": 60 }))).status).toBe(400);
    expect((await patchSettingsRoute(patchJson("/api/admin/settings", { "gate.skipEverything": true }))).status).toBe(400);
  });

  it("non-administrators are refused", async () => {
    denyWith(mocks, 403, "forbidden");
    expect((await patchSettingsRoute(patchJson("/api/admin/settings", { "gate.autoAcceptEnabled": false }))).status).toBe(403);
    expect(getSettings(db)["gate.autoAcceptEnabled"]).toBe(true);
  });
});

// ── CSV ──────────────────────────────────────────────────────────────────

describe("CSV", () => {
  it("parses quotes, escaped quotes, embedded newlines, CRLF, BOM and ';' files", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n"multi\nline",z\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["multi\nline", "z"],
    ]);
    expect(parseCsv("a;b\n1;2,5\n")).toEqual([["a", "b"], ["1", "2,5"]]);
    expect(() => parseCsv('a\n"open')).toThrow(/Unterminated/);
  });

  it("export neutralizes spreadsheet formula injection", () => {
    expect(toCsv(["v"], [["=HYPERLINK(\"x\")"], ["+1"], ["normal"]])).toBe("v\r\n\"'=HYPERLINK(\"\"x\"\")\"\r\n'+1\r\nnormal\r\n");
  });
});

// ── Import ───────────────────────────────────────────────────────────────

const GOOD = [
  "truck_plate,container_no,driver_name,scheduled_at,status,external_ref",
  "12345-A-6,MSCU1234566,Driver One,2026-11-02T08:30:00Z,confirmed,TAS-1",
  "23456-B-7,,Driver Two,2026-11-02T09:00:00Z,,TAS-2",
].join("\n");

describe("appointment import", () => {
  it("dry run validates without writing", () => {
    const r = importAppointments(db, "u-sup", GOOD, { dryRun: true });
    expect(r).toMatchObject({ dryRun: true, rows: 2, valid: 2, created: 0, errorCount: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM appointments").get()).toEqual({ n: 0 });
  });

  it("commit creates rows with the requested status, records the batch, and re-imports are no-ops", () => {
    const first = importAppointments(db, "u-sup", GOOD, { dryRun: false, filename: "tas.csv" });
    expect(first).toMatchObject({ created: 2, skipped: 0 });
    const statuses = db.prepare("SELECT truck_plate, status FROM appointments ORDER BY truck_plate").all();
    expect(statuses).toEqual([
      { truck_plate: "12345-A-6", status: "confirmed" },
      { truck_plate: "23456-B-7", status: "requested" },
    ]);
    const again = importAppointments(db, "u-sup", GOOD, { dryRun: false });
    expect(again).toMatchObject({ created: 0, skipped: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM appointments").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM import_batches").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'import.completed'").get()).toEqual({ n: 2 });
  });

  it("reports row-level errors (bad container check digit, bad date, bad status, duplicate ref) and writes nothing", () => {
    const bad = [
      "truck_plate,container_no,scheduled_at,status,external_ref",
      "AAA-1,MSCU1234565,2026-11-02T08:30:00Z,,R1", // wrong check digit
      "AAA-2,,02/11/2026 08:30,,R2", // not ISO UTC
      "AAA-3,,2026-11-02T08:30:00Z,checked-in,R3", // status not importable
      ",,2026-11-02T08:30:00Z,,R1", // missing plate + duplicate ref
      "AAA-5,,2026-11-02T08:30:00Z,,R5", // valid
    ].join("\n");
    const dry = importAppointments(db, "u-sup", bad, { dryRun: true });
    expect(dry.valid).toBe(1);
    const fields = dry.errors.map((e) => `${e.row}:${e.field}`);
    expect(fields).toEqual(expect.arrayContaining(["1:container_no", "2:scheduled_at", "3:status", "4:external_ref", "4:truck_plate"]));
    expect(() => importAppointments(db, "u-sup", bad, { dryRun: false })).toThrow(/row error/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM appointments").get()).toEqual({ n: 0 });
  });

  it("rejects unknown/missing columns up front", () => {
    expect(() => importAppointments(db, "u", "plate,when\nX,Y", { dryRun: true })).toThrow(/Unknown column/);
    expect(() => importAppointments(db, "u", "truck_plate\nX", { dryRun: true })).toThrow(/Missing required/);
  });

  it("route: supervisor+ only; dry run 200, commit 201, history listed", async () => {
    denyWith(mocks, 403, "forbidden");
    expect((await importRoute(csvReq(GOOD, "?dryRun=1"))).status).toBe(403);
    allowAs(mocks, SUPERVISOR);
    expect((await importRoute(csvReq(GOOD, "?dryRun=1"))).status).toBe(200);
    const commit = await importRoute(csvReq(GOOD, "?filename=tas.csv"));
    expect(commit.status).toBe(201);
    const list = await (await listImportsRoute(getReq("/api/imports"))).json();
    expect(list.batches[0]).toMatchObject({ filename: "tas.csv", created: 2 });
  });

  it("route: 422 when a committed file has errors; 400 on empty body", async () => {
    allowAs(mocks, SUPERVISOR);
    const res = await importRoute(csvReq("truck_plate,scheduled_at\nX,not-a-date"));
    expect(res.status).toBe(422);
    expect((await importRoute(csvReq("   "))).status).toBe(400);
  });
});

// ── Export & audit ───────────────────────────────────────────────────────

describe("exports and the audit viewer", () => {
  it("appointments export returns CSV with the import's external_ref", async () => {
    importAppointments(db, "u-sup", GOOD, { dryRun: false });
    allowAs(mocks, VIEWER);
    const res = await exportAppointments(getReq("/api/appointments/export"));
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    const rows = parseCsv(await res.text());
    expect(rows[0]).toContain("external_ref");
    expect(rows.slice(1).map((r) => r[rows[0].indexOf("external_ref")]).sort()).toEqual(["TAS-1", "TAS-2"]);
    expect((await exportAppointments(getReq("/api/appointments/export?status=bogus"))).status).toBe(400);
  });

  it("audit viewer filters by action and the export is itself audited", async () => {
    importAppointments(db, "u-sup", GOOD, { dryRun: false });
    updateSettings(db, "u-admin", { "gate.reviewThreshold": 80 });
    allowAs(mocks, ADMIN);
    const page = await (await getAuditRoute(getReq("/api/admin/audit?action=settings.changed"))).json();
    expect(page.total).toBe(1);
    expect(page.rows[0].action).toBe("settings.changed");

    const exp = await exportAuditRoute(getReq("/api/admin/audit/export"));
    expect(exp.headers.get("content-disposition")).toMatch(/attachment; filename="audit-/);
    expect(parseCsv(await exp.text()).length).toBe(1 + 2); // header + import + setting
    expect(mocks.audit).toHaveBeenCalledWith(ADMIN.userId, "audit.exported", "audit_events", "export", expect.objectContaining({ rows: 2 }));
  });

  it("forwarder ships every audit row once, in order, and resumes after a failure", async () => {
    importAppointments(db, "u-sup", GOOD, { dryRun: false });
    updateSettings(db, "u-admin", { "gate.autoAcceptEnabled": false });
    const received: Array<{ action: string; seq: number }> = [];
    let fail = true;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      if (fail) return new Response("down", { status: 503 });
      received.push(...JSON.parse(String(init.body)).events);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(forwardAuditBatch(db, { url: "https://siem.example/hook", fetchImpl })).rejects.toThrow(/503/);
    fail = false;
    expect(await forwardAuditBatch(db, { url: "https://siem.example/hook", fetchImpl })).toBe(2);
    expect(received.map((e) => e.action)).toEqual(["import.completed", "settings.changed"]);
    expect(await forwardAuditBatch(db, { url: "https://siem.example/hook", fetchImpl })).toBe(0); // nothing new
    updateSettings(db, "u-admin", { "gate.autoAcceptEnabled": true });
    expect(await forwardAuditBatch(db, { url: "https://siem.example/hook", fetchImpl })).toBe(1);
    expect(received[2].seq).toBeGreaterThan(received[1].seq);
  });
});
