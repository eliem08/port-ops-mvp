// Database client — node:sqlite (built into Node 22.5+).
// Single file database, zero infrastructure. Synchronous API.

import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const DB_PATH = process.env.DATABASE_URL?.replace("file:", "") ?? "./dev.db";
const resolved = path.isAbsolute(DB_PATH) ? DB_PATH : path.join(process.cwd(), DB_PATH);

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!_db) {
    _db = new DatabaseSync(resolved);
    // Foreign keys + WAL for safety
    _db.exec("PRAGMA foreign_keys = ON;");
    _db.exec("PRAGMA journal_mode = WAL;");
  }
  return _db;
}

// For tests: in-memory database
export function getTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}
