// Operations: migrations runner, online backup / verify / prune / restore,
// Prometheus metrics, readiness and metrics endpoints, admin bootstrap.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NextRequest } from "next/server";
import { LATEST_SCHEMA_VERSION, runMigrations, schemaVersion } from "./db/run-migrations";
import { backupDatabase, listBackups, pruneBackups, restoreDatabase, verifyDatabaseFile } from "./db/backup";
import { collectMetrics } from "./metrics";
import { bootstrapAdmin } from "./startup";

const dbHolder = vi.hoisted(() => ({ db: null as DatabaseSync | null }));
vi.mock("@/lib/db/client", () => ({ getDb: () => dbHolder.db }));

let dir: string;
let file: string;
let db: DatabaseSync;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "portops-ops-"));
  file = path.join(dir, "live.db");
  db = new DatabaseSync(file);
  runMigrations(db);
  dbHolder.db = db;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("migrations", () => {
  it("brings an empty database to the latest version and is idempotent", () => {
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(runMigrations(db).applied).toEqual([]);
  });
});

describe("backup & restore", () => {
  it("takes a consistent, verified snapshot that contains the live data", () => {
    db.prepare("INSERT INTO users (id, label, role) VALUES ('u1', 'One', 'planner')").run();
    const b = backupDatabase(db, path.join(dir, "backups"));
    expect(b.name).toMatch(/^portops-\d{8}T\d{6}Z\.db$/);
    expect(verifyDatabaseFile(b.file)).toMatchObject({ ok: true, schemaVersion: LATEST_SCHEMA_VERSION });
    const copy = new DatabaseSync(b.file, { readOnly: true });
    expect(copy.prepare("SELECT label FROM users WHERE id = 'u1'").get()).toEqual({ label: "One" });
    copy.close();
  });

  it("prunes to the newest N backups", () => {
    const bdir = path.join(dir, "backups");
    backupDatabase(db, bdir);
    for (const name of ["portops-20200101T000000Z.db", "portops-20210101T000000Z.db"]) {
      writeFileSync(path.join(bdir, name), "old");
      utimesSync(path.join(bdir, name), new Date(2020, 0, 1), new Date(2020, 0, 1));
    }
    expect(listBackups(bdir)).toHaveLength(3);
    expect(pruneBackups(1, bdir).sort()).toEqual(["portops-20200101T000000Z.db", "portops-20210101T000000Z.db"]);
    expect(listBackups(bdir)).toHaveLength(1);
  });

  it("restores a backup and keeps the replaced database aside", () => {
    db.prepare("INSERT INTO users (id, label, role) VALUES ('before', 'Before', 'planner')").run();
    const b = backupDatabase(db, path.join(dir, "backups"));
    db.prepare("INSERT INTO users (id, label, role) VALUES ('after', 'After', 'planner')").run();
    db.close();

    const { previous } = restoreDatabase(b.file, file);
    expect(previous && existsSync(previous)).toBe(true);
    db = new DatabaseSync(file);
    expect(db.prepare("SELECT id FROM users ORDER BY id").all()).toEqual([{ id: "before" }]);
  });

  it("refuses to restore a corrupt or foreign file", () => {
    const junk = path.join(dir, "junk.db");
    writeFileSync(junk, "this is not a database");
    expect(() => restoreDatabase(junk, file)).toThrow(/refusing to restore/);
    const foreign = path.join(dir, "foreign.db");
    const f = new DatabaseSync(foreign);
    f.exec("CREATE TABLE t (x)");
    f.close();
    expect(verifyDatabaseFile(foreign)).toMatchObject({ ok: false, detail: "not a platform database" });
  });
});

describe("metrics", () => {
  it("emits valid Prometheus exposition with business and process gauges", () => {
    db.prepare("INSERT INTO appointments (id, truck_plate, scheduled_at, status, created_by) VALUES ('a1', 'X', '2026-01-01T00:00:00Z', 'confirmed', 'u')").run();
    const text = collectMetrics(db, file);
    expect(text).toContain('# TYPE portops_appointments gauge');
    expect(text).toContain('portops_appointments{status="confirmed"} 1');
    expect(text).toContain(`portops_schema_version ${LATEST_SCHEMA_VERSION}`);
    expect(text).toMatch(/portops_database_bytes \d+/);
    for (const line of text.trim().split("\n")) {
      expect(line).toMatch(/^(# (HELP|TYPE) \w+ .+|\w+(\{[^}]*\})? -?\d+(\.\d+)?(e[+-]?\d+)?)$/);
    }
  });

  it("endpoint: 404 when disabled, 401 with a wrong token, 200 with the right one", async () => {
    const { GET } = await import("@/app/api/metrics/route");
    const req = (auth?: string) => new NextRequest("http://localhost/api/metrics", { headers: auth ? { authorization: auth } : {} });
    expect((await GET(req())).status).toBe(404);
    vi.stubEnv("METRICS_TOKEN", "scrape-secret");
    expect((await GET(req("Bearer nope"))).status).toBe(401);
    const ok = await GET(req("Bearer scrape-secret"));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/text\/plain; version=0.0.4/);
  });
});

describe("readiness", () => {
  it("200 when migrated, 503 when the schema is behind", async () => {
    const { GET } = await import("@/app/api/ready/route");
    expect((await GET()).status).toBe(200);
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(LATEST_SCHEMA_VERSION);
    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe("migrations_pending");
  });
});

describe("bootstrap administrator", () => {
  const env = { BOOTSTRAP_ADMIN_EMAIL: "ops-admin@example.com", BOOTSTRAP_ADMIN_PASSWORD: "first-boot-passphrase-2026" };

  it("creates a forced-password-change admin only when none exists", () => {
    const id = bootstrapAdmin(db, env);
    expect(id).toBeTruthy();
    expect(db.prepare("SELECT role, must_change_password FROM users WHERE id = ?").get(id!)).toEqual({ role: "administrator", must_change_password: 1 });
    expect(bootstrapAdmin(db, { ...env, BOOTSTRAP_ADMIN_EMAIL: "other@example.com" })).toBeNull();
  });

  it("is inert without both variables and rejects weak passwords", () => {
    expect(bootstrapAdmin(db, { BOOTSTRAP_ADMIN_EMAIL: "a@example.com" })).toBeNull();
    expect(() => bootstrapAdmin(db, { ...env, BOOTSTRAP_ADMIN_PASSWORD: "short" })).toThrow(/at least 12/);
  });
});
