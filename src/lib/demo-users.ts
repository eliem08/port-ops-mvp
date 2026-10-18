// Demo identities for the login page. Reads the demo_users table so the
// page always lists exactly the identities the backend will accept.

import { getDb } from "./db/client";
import { DemoRole } from "@/contracts";

export interface DemoUserInfo {
  id: string;
  label: string;
  role: DemoRole;
}

export function listDemoUsers(): DemoUserInfo[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, label, role FROM demo_users ORDER BY id")
    .all() as Array<{ id: string; label: string; role: string }>;
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    role: DemoRole.parse(r.role),
  }));
}
