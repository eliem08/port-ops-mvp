// Reset the demo database. DEMO ONLY — refuses to run in production.
// Usage: npm run db:reset
import { getDb } from "./client";
import fs from "node:fs";
import path from "node:path";

function main() {
  if (process.env.NODE_ENV === "production") {
    console.error("REFUSED: db:reset is disabled in production.");
    process.exit(1);
  }
  if (process.env.ALLOW_DB_RESET !== "1") {
    console.error("REFUSED: set ALLOW_DB_RESET=1 to confirm you want to wipe the demo database.");
    process.exit(1);
  }
  const dbPath = process.env.DATABASE_URL?.replace("file:", "") ?? "./dev.db";
  const resolved = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);
  // Close not needed for fresh process; just delete the files
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(resolved + suffix); } catch { /* ignore */ }
  }
  console.log(`demo database wiped: ${resolved}`);
  console.log("run `npm run db:migrate && npm run db:seed` to start fresh.");
}

main();
