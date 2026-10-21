// Backup / restore CLI.
//   npm run db:backup                       snapshot now (+ prune to BACKUP_KEEP)
//   npm run db:backup -- --list             list backups
//   npm run db:restore -- <backup-file>     restore (STOP THE APP FIRST)

import path from "node:path";
import { getDb } from "./client";
import { backupDatabase, listBackups, pruneBackups, restoreDatabase } from "./backup";

function dbFile(): string {
  const p = process.env.DATABASE_URL?.replace("file:", "") ?? "./dev.db";
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "restore") {
    if (!arg) throw new Error("usage: npm run db:restore -- <backup-file>");
    const { previous } = restoreDatabase(path.resolve(arg), dbFile());
    console.log(`restored ${arg} → ${dbFile()}`);
    if (previous) console.log(`previous database kept at ${previous}`);
    return;
  }
  if (arg === "--list" || cmd === "--list") {
    for (const b of listBackups()) console.log(`${b.name}\t${(b.bytes / 1024).toFixed(0)} KiB\t${b.createdAt}`);
    return;
  }
  const b = backupDatabase(getDb());
  console.log(`backup written: ${b.file} (${(b.bytes / 1024).toFixed(0)} KiB, integrity ok)`);
  const removed = pruneBackups();
  if (removed.length) console.log(`pruned ${removed.length} old backup(s)`);
}

try {
  main();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
