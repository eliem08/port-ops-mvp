// Seed the demo database with clearly-labeled synthetic records.
// Usage: npm run db:seed
// All records are SYNTHETIC — no real port data, no real people.
import { getDb } from "./client";
import { randomUUID } from "node:crypto";

const SYNTHETIC_TAG = "[SYNTHETIC DEMO DATA]";

function main() {
  const db = getDb();

  // Demo users — one per role
  const users = [
    { id: "demo-viewer", label: "Yasmine (Viewer)", role: "operations_viewer" },
    { id: "demo-operator", label: "Omar (Operator)", role: "operations_operator" },
    { id: "demo-planner", label: "Salma (Planner)", role: "planner" },
    { id: "demo-supervisor", label: "Karim (Supervisor)", role: "supervisor" },
    { id: "demo-admin", label: "Admin (Demo)", role: "administrator" },
  ];
  const upsertUser = db.prepare(
    "INSERT OR IGNORE INTO demo_users (id, label, role) VALUES (?, ?, ?)"
  );
  for (const u of users) upsertUser.run(u.id, u.label, u.role);
  console.log(`seeded ${users.length} demo users`);

  // Synthetic appointments — uses the TAS six-status contract enum
  // (requested | confirmed | checked-in | completed | cancelled | no-show)
  const now = new Date();
  const appts = [
    { plate: "CAS-4821-A", container: "TCLU4829103", driver: "Demo Driver 1", hours: 2, status: "confirmed" },
    { plate: "CAS-7734-B", container: "MSKU7734120", driver: "Demo Driver 2", hours: 4, status: "requested" },
    { plate: "CAS-1190-C", container: "OOLU1190345", driver: "Demo Driver 3", hours: -1, status: "checked-in" },
    { plate: "CAS-5562-D", container: "EITU5562781", driver: "Demo Driver 4", hours: -3, status: "completed" },
    { plate: "CAS-9087-E", container: null, driver: "Demo Driver 5", hours: 6, status: "requested" },
  ];
  const insertAppt = db.prepare(
    `INSERT OR IGNORE INTO appointments
     (id, truck_plate, container_no, driver_name, scheduled_at, status, created_by, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let n = 0;
  for (const a of appts) {
    const id = randomUUID();
    const scheduled = new Date(now.getTime() + a.hours * 3600_000).toISOString();
    const r = insertAppt.run(id, a.plate, a.container, `${SYNTHETIC_TAG} ${a.driver}`, scheduled, a.status, "demo-operator", `seed-${a.plate}`);
    if (r.changes > 0) {
      n++;
      // Audit event for the seeded appointment
      db.prepare(
        `INSERT INTO audit_events (id, actor_id, action, entity, entity_id, detail_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), "demo-operator", "appointment.created", "appointment", id,
        JSON.stringify({ synthetic: true, seed: true }));
    }
  }
  console.log(`seeded ${n} synthetic appointments`);

  console.log("done. All records labeled synthetic.");
}

main();
