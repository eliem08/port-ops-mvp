// Seeded demonstration accounts (ids "demo-*"), listed on the login page only
// while the database holds the synthetic demo seed. Passwords are never shown;
// the seed prints them (see docs/DEMO-GUIDE.md).

import { getDb } from "./db/client";
import { Role } from "@/contracts";

export interface DemoUserInfo {
  id: string;
  label: string;
  role: Role;
  email: string | null;
}

export function listDemoUsers(): DemoUserInfo[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, label, role, email FROM users WHERE id LIKE 'demo-%' AND disabled = 0 ORDER BY id")
    .all() as Array<{ id: string; label: string; role: string; email: string | null }>;
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    role: Role.parse(r.role),
    email: r.email,
  }));
}
