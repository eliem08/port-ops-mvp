// Deployment-level facts the UI needs: product name and whether the database
// contains the synthetic demo seed (so the synthetic-data banner appears
// exactly when it is true — never on a database holding only real records).

import type { DatabaseSync } from "node:sqlite";

export function appName(): string {
  return process.env.APP_NAME?.trim() || "Port Operations Intelligence";
}

export function demoDataPresent(db: DatabaseSync): boolean {
  try {
    const row = db
      .prepare(
        `SELECT 1 FROM appointments WHERE driver_name LIKE '[SYNTHETIC DEMO DATA]%'
         UNION ALL SELECT 1 FROM audit_events WHERE detail_json LIKE '%"seed":true%'
         LIMIT 1`
      )
      .get();
    return row !== undefined;
  } catch {
    return false; // schema not migrated yet
  }
}
