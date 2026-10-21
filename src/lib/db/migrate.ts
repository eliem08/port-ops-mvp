// Run pending migrations. Usage: npm run db:migrate
// (The server also applies them at start-up unless AUTO_MIGRATE=false.)
import { getDb } from "./client";
import { MIGRATIONS } from "./migrations";
import { runMigrations } from "./run-migrations";

const { applied } = runMigrations(getDb());
for (const m of MIGRATIONS) {
  console.log(`migration ${m.version}: ${applied.includes(m.version) ? "applied" : "already applied"}`);
}
