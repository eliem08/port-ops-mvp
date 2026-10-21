// Server start-up tasks (Node runtime), run once from src/instrumentation.ts:
// 1. Apply pending database migrations (AUTO_MIGRATE, default on).
// 2. Bootstrap the first administrator from BOOTSTRAP_ADMIN_EMAIL +
//    BOOTSTRAP_ADMIN_PASSWORD — only while NO active administrator exists,
//    so the variables are inert after first use (remove them anyway).
// 3. Scheduled online backups every BACKUP_INTERVAL_HOURS (off when unset).
// 4. Audit shipping to AUDIT_WEBHOOK_URL (off when unset).

import type { DatabaseSync } from "node:sqlite";
import { createUser } from "./accounts";
import { startAuditForwarder } from "./audit-forwarder";
import { backupDatabase, pruneBackups } from "./db/backup";
import { runMigrations } from "./db/run-migrations";
import { logger } from "./logger";

export function bootstrapAdmin(db: DatabaseSync, env: Record<string, string | undefined> = process.env): string | null {
  const email = env.BOOTSTRAP_ADMIN_EMAIL;
  const password = env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) return null;
  const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'administrator' AND disabled = 0").get() as { n: number };
  if (Number(admins.n) > 0) return null;
  const user = createUser(db, "system:bootstrap", {
    email,
    label: env.BOOTSTRAP_ADMIN_NAME ?? "Administrator",
    role: "administrator",
    password,
  });
  return user.id;
}

let backupTimer: NodeJS.Timeout | null = null;

export function runStartupTasks(getDb: () => DatabaseSync): void {
  const env = process.env;
  const db = getDb();

  if (env.AUTO_MIGRATE !== "false") {
    const { applied, current } = runMigrations(db);
    logger.info("database schema ready", { applied, schema: current });
  }

  const adminId = bootstrapAdmin(db);
  if (adminId) {
    logger.warn("bootstrap administrator created — they must change the password at first sign-in; remove BOOTSTRAP_ADMIN_* from the environment", {
      userId: adminId,
      email: env.BOOTSTRAP_ADMIN_EMAIL,
    });
  }

  const hours = Number(env.BACKUP_INTERVAL_HOURS);
  if (hours > 0 && !backupTimer) {
    backupTimer = setInterval(() => {
      try {
        const b = backupDatabase(getDb());
        const pruned = pruneBackups();
        logger.info("scheduled backup written", { file: b.name, bytes: b.bytes, pruned: pruned.length });
      } catch (err) {
        logger.error("scheduled backup failed", { err });
      }
    }, hours * 3600_000);
    backupTimer.unref();
    logger.info("scheduled backups enabled", { everyHours: hours });
  }

  startAuditForwarder(getDb);
}
