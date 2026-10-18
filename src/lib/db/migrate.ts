// Run pending migrations. Usage: npm run db:migrate
import { getDb } from "./client";
import { MIGRATIONS } from "./migrations";

function main() {
  const db = getDb();
  // Ensure the tracking table exists even on a fresh DB
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));");
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[])
      .map((r) => r.version)
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) {
      console.log(`migration ${m.version}: already applied`);
      continue;
    }
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(m.version);
      db.exec("COMMIT");
      console.log(`migration ${m.version}: applied`);
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

main();
