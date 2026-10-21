// Online backups and verified restores for the SQLite database.
// - backupDatabase(): VACUUM INTO a timestamped file — a consistent,
//   compacted snapshot taken while the app keeps serving (no downtime).
//   The copy is integrity-checked before it counts as a backup.
// - pruneBackups(): keeps the newest N files (BACKUP_KEEP, default 14).
// - restoreDatabase(): verifies the backup, keeps the current database as
//   "<db>.pre-restore-<stamp>", then swaps the file in. Run it with the app
//   stopped (see docs/OPERATIONS.md).

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PREFIX = "portops-";

export function backupDir(): string {
  const dir = process.env.BACKUP_DIR || "./backups";
  return path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

/** Opens a database file read-only and runs SQLite's full integrity check. */
export function verifyDatabaseFile(file: string): { ok: boolean; detail: string; schemaVersion: number } {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    const detail = rows.map((r) => r.integrity_check).join("; ");
    let version = 0;
    try {
      version = Number((db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null }).v ?? 0);
    } catch {
      // not a platform database
    }
    return { ok: detail === "ok" && version > 0, detail: version > 0 ? detail : "not a platform database", schemaVersion: version };
  } catch (err) {
    return { ok: false, detail: (err as Error).message, schemaVersion: 0 };
  } finally {
    db?.close();
  }
}

export interface BackupInfo {
  file: string;
  name: string;
  bytes: number;
  createdAt: string;
}

export function backupDatabase(db: DatabaseSync, dir = backupDir()): BackupInfo {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${PREFIX}${stamp()}.db`);
  db.prepare("VACUUM INTO ?").run(file);
  const check = verifyDatabaseFile(file);
  if (!check.ok) {
    try {
      unlinkSync(file);
    } catch {
      // ignore
    }
    throw new Error(`backup failed verification: ${check.detail}`);
  }
  const st = statSync(file);
  return { file, name: path.basename(file), bytes: st.size, createdAt: st.mtime.toISOString() };
}

export function listBackups(dir = backupDir()): BackupInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.startsWith(PREFIX) && n.endsWith(".db"))
    .map((name) => {
      const file = path.join(dir, name);
      const st = statSync(file);
      return { file, name, bytes: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name)); // timestamped names → newest first
}

export function pruneBackups(keep = Number(process.env.BACKUP_KEEP) > 0 ? Number(process.env.BACKUP_KEEP) : 14, dir = backupDir()): string[] {
  const removed: string[] = [];
  for (const b of listBackups(dir).slice(keep)) {
    unlinkSync(b.file);
    removed.push(b.name);
  }
  return removed;
}

export function restoreDatabase(backupFile: string, targetFile: string): { previous: string | null } {
  const check = verifyDatabaseFile(backupFile);
  if (!check.ok) throw new Error(`refusing to restore: ${check.detail}`);
  let previous: string | null = null;
  if (existsSync(targetFile)) {
    previous = `${targetFile}.pre-restore-${stamp()}`;
    renameSync(targetFile, previous);
  }
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(targetFile + suffix)) unlinkSync(targetFile + suffix);
  }
  copyFileSync(backupFile, targetFile);
  return { previous };
}
