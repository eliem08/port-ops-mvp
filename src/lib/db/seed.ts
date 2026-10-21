// Seed the demo database with clearly-labeled synthetic records.
// Usage: npm run db:seed
// Idempotent: every record uses a stable seed ID + INSERT OR IGNORE,
// so re-running never duplicates. For a fully fresh start, run
//   ALLOW_DB_RESET=1 npm run db:reset && npm run db:migrate && npm run db:seed
// ALL records are SYNTHETIC — no real port data, no real people,
// no real vessel schedules, no real container numbers.
import { randomBytes } from "node:crypto";
import { getDb } from "./client";
import { hashPassword, passwordPolicyError } from "../password";

const SYNTHETIC_TAG = "[SYNTHETIC DEMO DATA]";

// ---------------------------------------------------------------------------
// ISO 6346 check-digit: makes seeded container numbers structurally valid
// (4 owner/category letters + 6 serial digits + 1 check digit = 11 chars).
// These are still SYNTHETIC — generated, never observed in the real world.
// ---------------------------------------------------------------------------
const LETTER_VALUES: Record<string, number> = {
  A: 10, B: 12, C: 13, D: 14, E: 15, F: 16, G: 17, H: 18, I: 19, J: 20,
  K: 21, L: 23, M: 24, N: 25, O: 26, P: 27, Q: 28, R: 29, S: 30, T: 31,
  U: 32, V: 34, W: 35, X: 36, Y: 37, Z: 38,
};

function iso6346(owner4: string, six: string): string {
  const base = (owner4 + six).toUpperCase(); // 10 chars
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = base[i];
    const v = /[A-Z]/.test(ch) ? LETTER_VALUES[ch]! : parseInt(ch, 10);
    sum += v * 2 ** i;
  }
  return base + String((sum % 11) % 10);
}

// Anchor: today 09:00 UTC. All times are ISO 8601 UTC.
const BASE = (() => {
  const d = new Date();
  d.setUTCHours(9, 0, 0, 0);
  return d;
})();
const at = (hours: number) => new Date(BASE.getTime() + hours * 3600_000).toISOString();

interface ApptDef {
  id: string;
  plate: string;
  container: string | null;
  driver: string;
  offsetH: number;
  status: string;
  createdBy: string;
}

const APPTS: ApptDef[] = [
  // --- yesterday: completed ---
  { id: "seed-appt-001", plate: "CAS-4821-A", container: iso6346("TCLU", "482910"), driver: "Yassine El Fassi", offsetH: -27, status: "completed", createdBy: "demo-operator" },
  { id: "seed-appt-002", plate: "TNG-2290-B", container: iso6346("MSKU", "229018"), driver: "Mehdi Benali", offsetH: -25, status: "completed", createdBy: "demo-operator" },
  { id: "seed-appt-003", plate: "CAS-7734-B", container: iso6346("OOLU", "773412"), driver: "Omar Cherkaoui", offsetH: -23, status: "completed", createdBy: "demo-operator" },
  { id: "seed-appt-004", plate: "RBA-3105-A", container: iso6346("CMAU", "310566"), driver: "Salma Idrissi", offsetH: -21, status: "completed", createdBy: "demo-operator" },
  // --- yesterday: no-show ---
  { id: "seed-appt-005", plate: "AGA-6642-C", container: iso6346("COSU", "664201"), driver: "Hassan El Ouafi", offsetH: -20, status: "no-show", createdBy: "demo-operator" },
  { id: "seed-appt-006", plate: "CAS-1190-C", container: iso6346("HLCU", "119034"), driver: "Rachid El Mansouri", offsetH: -18, status: "no-show", createdBy: "demo-operator" },
  // --- cancelled ---
  { id: "seed-appt-007", plate: "MAR-8810-D", container: null, driver: "Fatima Zahra El Amrani", offsetH: -5, status: "cancelled", createdBy: "demo-supervisor" },
  { id: "seed-appt-008", plate: "FES-4420-B", container: iso6346("TRHU", "442087"), driver: "Nabil Tazi", offsetH: 3, status: "cancelled", createdBy: "demo-operator" },
  // --- today: checked-in ---
  { id: "seed-appt-009", plate: "CAS-5562-D", container: iso6346("EITU", "556278"), driver: "Karim Bennani", offsetH: -1, status: "checked-in", createdBy: "demo-operator" },
  { id: "seed-appt-010", plate: "TNG-9087-E", container: iso6346("BSIU", "908715"), driver: "Aicha Berrada", offsetH: -0.5, status: "checked-in", createdBy: "demo-operator" },
  // --- today/tomorrow: confirmed ---
  { id: "seed-appt-011", plate: "CAS-2045-A", container: iso6346("TCLU", "204533"), driver: "Younes El Haddaoui", offsetH: 2, status: "confirmed", createdBy: "demo-operator" },
  { id: "seed-appt-012", plate: "TNG-7712-C", container: iso6346("MSKU", "771209"), driver: "Sara Benkirane", offsetH: 4, status: "confirmed", createdBy: "demo-operator" },
  { id: "seed-appt-013", plate: "CAS-3391-B", container: iso6346("OOLU", "339177"), driver: "Mohamed El Idrissi", offsetH: 6, status: "confirmed", createdBy: "demo-operator" },
  { id: "seed-appt-014", plate: "MOH-5520-A", container: iso6346("CMAU", "552041"), driver: "Khadija El Fihri", offsetH: 26, status: "confirmed", createdBy: "demo-operator" },
  { id: "seed-appt-015", plate: "RBA-9083-D", container: iso6346("COSU", "908322"), driver: "Abdellatif Bouchta", offsetH: 28, status: "confirmed", createdBy: "demo-supervisor" },
  // --- tomorrow: requested ---
  { id: "seed-appt-016", plate: "CAS-8844-E", container: iso6346("HLCU", "884410"), driver: "Ilham El Gharbi", offsetH: 30, status: "requested", createdBy: "demo-operator" },
  { id: "seed-appt-017", plate: "TNG-1160-A", container: iso6346("TRHU", "116053"), driver: "Tarek El Boury", offsetH: 32, status: "requested", createdBy: "demo-operator" },
  { id: "seed-appt-018", plate: "AGA-2210-B", container: iso6346("BSIU", "221096"), driver: "Nadia El Kabbaj", offsetH: 34, status: "requested", createdBy: "demo-operator" },
  { id: "seed-appt-019", plate: "MAR-6654-C", container: null, driver: "Driss El Alaoui", offsetH: 36, status: "requested", createdBy: "demo-operator" },
  { id: "seed-appt-020", plate: "CAS-9902-D", container: iso6346("TCLU", "990274"), driver: "Zineb El Meziane", offsetH: 38, status: "requested", createdBy: "demo-operator" },
];

const apptById = new Map(APPTS.map((a) => [a.id, a]));

interface GateDef {
  id: string;
  apptId: string;
  plateRead: string | null;
  containerRead: string | null;
  confidence: number | null;
  outcome: "auto-accept" | "human-review" | "scan-failed";
  reason: string;
  verifiedBy: string;
  offsetH: number;
}

const GATES: GateDef[] = [
  { id: "seed-gate-001", apptId: "seed-appt-001", plateRead: "CAS-4821-A", containerRead: apptById.get("seed-appt-001")!.container, confidence: 97.4, outcome: "auto-accept", reason: `${SYNTHETIC_TAG} Plate and container reads matched appointment; confidence within auto-accept band.`, verifiedBy: "demo-operator", offsetH: -26.7 },
  { id: "seed-gate-002", apptId: "seed-appt-002", plateRead: "TNG-2298-B", containerRead: apptById.get("seed-appt-002")!.container, confidence: 63.2, outcome: "human-review", reason: `${SYNTHETIC_TAG} Plate read mismatch: expected TNG-2290-B, camera read TNG-2298-B.`, verifiedBy: "demo-operator", offsetH: -24.7 },
  { id: "seed-gate-003", apptId: "seed-appt-002", plateRead: "TNG-2290-B", containerRead: apptById.get("seed-appt-002")!.container, confidence: 96.8, outcome: "auto-accept", reason: `${SYNTHETIC_TAG} Rescan after repositioning: reads matched appointment.`, verifiedBy: "demo-operator", offsetH: -24.5 },
  { id: "seed-gate-004", apptId: "seed-appt-003", plateRead: null, containerRead: null, confidence: null, outcome: "scan-failed", reason: `${SYNTHETIC_TAG} Both cameras returned empty reads — dust on lens flagged to maintenance.`, verifiedBy: "demo-operator", offsetH: -22.7 },
  { id: "seed-gate-005", apptId: "seed-appt-003", plateRead: "CAS-7734-B", containerRead: "OOLU7734220", confidence: 71.5, outcome: "human-review", reason: `${SYNTHETIC_TAG} Container read mismatch: expected ${apptById.get("seed-appt-003")!.container}, camera read OOLU7734220.`, verifiedBy: "demo-operator", offsetH: -22.5 },
  { id: "seed-gate-006", apptId: "seed-appt-004", plateRead: "RBA-3105-A", containerRead: apptById.get("seed-appt-004")!.container, confidence: 98.1, outcome: "auto-accept", reason: `${SYNTHETIC_TAG} Plate and container reads matched appointment; confidence within auto-accept band.`, verifiedBy: "demo-operator", offsetH: -20.7 },
  { id: "seed-gate-009", apptId: "seed-appt-009", plateRead: "CAS-5562-D", containerRead: null, confidence: 41.0, outcome: "scan-failed", reason: `${SYNTHETIC_TAG} Container camera timed out; plate read OK.`, verifiedBy: "demo-operator", offsetH: -1.2 },
  { id: "seed-gate-007", apptId: "seed-appt-009", plateRead: "CAS-5562-D", containerRead: apptById.get("seed-appt-009")!.container, confidence: 95.9, outcome: "auto-accept", reason: `${SYNTHETIC_TAG} Rescan: plate and container reads matched appointment.`, verifiedBy: "demo-operator", offsetH: -0.9 },
  { id: "seed-gate-008", apptId: "seed-appt-010", plateRead: "TNG-9087-F", containerRead: apptById.get("seed-appt-010")!.container, confidence: 58.3, outcome: "human-review", reason: `${SYNTHETIC_TAG} Plate read mismatch: expected TNG-9087-E, camera read TNG-9087-F.`, verifiedBy: "demo-operator", offsetH: -0.4 },
  { id: "seed-gate-010", apptId: "seed-appt-010", plateRead: null, containerRead: null, confidence: null, outcome: "scan-failed", reason: `${SYNTHETIC_TAG} Glare on plate camera; empty reads.`, verifiedBy: "demo-operator", offsetH: -0.3 },
];

interface ReviewDef {
  id: string;
  gateId: string;
  status: "pending" | "approved" | "rejected";
  decidedBy: string | null;
  offsetH: number | null; // decided_at
  note: string;
}

const REVIEWS: ReviewDef[] = [
  { id: "seed-review-001", gateId: "seed-gate-002", status: "rejected", decidedBy: "demo-supervisor", offsetH: -24.2, note: `${SYNTHETIC_TAG} Wrong lane: the truck belonged to an adjacent booking. Driver redirected; rescan accepted.` },
  { id: "seed-review-002", gateId: "seed-gate-005", status: "approved", decidedBy: "demo-supervisor", offsetH: -22.0, note: `${SYNTHETIC_TAG} Shipping documents checked manually; camera misread digit 1 as 2. Cleared.` },
  { id: "seed-review-003", gateId: "seed-gate-008", status: "pending", decidedBy: null, offsetH: null, note: `${SYNTHETIC_TAG} Awaiting supervisor decision.` },
];

interface BerthPlanDef {
  id: string;
  name: string;
  inputHash: string;
  solver: string;
  provenOptimal: 0 | 1;
  vessels: { name: string; loa_m: number; draft_m: number; teu: number }[];
  assignments: { vessel: string; berth: string }[];
  objective: Record<string, number>;
  assumptions: string[];
  offsetH: number;
}

const BERTH_PLANS: BerthPlanDef[] = [
  {
    id: "seed-berth-001", name: `${SYNTHETIC_TAG} Coastal feeder pair — exact`, inputHash: "seed-berth-input-001",
    solver: "ILP (branch-and-bound)", provenOptimal: 1,
    vessels: [
      { name: "SYNTHETIC Rif Wind", loa_m: 172, draft_m: 10.2, teu: 1800 },
      { name: "SYNTHETIC Atlas Pearl", loa_m: 149, draft_m: 9.4, teu: 1100 },
    ],
    assignments: [
      { vessel: "SYNTHETIC Rif Wind", berth: "Q2" },
      { vessel: "SYNTHETIC Atlas Pearl", berth: "Q4" },
    ],
    objective: { total_waiting_h: 1.5, berth_utilization_pct: 68 },
    assumptions: [`${SYNTHETIC_TAG} Tiny instance (2 vessels, 4 berths) solved to proven optimality.`, "Berth windows are fixed; crane productivity assumed constant."],
    offsetH: -30,
  },
  {
    id: "seed-berth-002", name: `${SYNTHETIC_TAG} Three-vessel window — exact`, inputHash: "seed-berth-input-002",
    solver: "ILP (branch-and-bound)", provenOptimal: 1,
    vessels: [
      { name: "SYNTHETIC Rif Wind", loa_m: 172, draft_m: 10.2, teu: 1800 },
      { name: "SYNTHETIC Atlas Pearl", loa_m: 149, draft_m: 9.4, teu: 1100 },
      { name: "SYNTHETIC Souss Voyager", loa_m: 240, draft_m: 12.0, teu: 4500 },
    ],
    assignments: [
      { vessel: "SYNTHETIC Souss Voyager", berth: "Q1" },
      { vessel: "SYNTHETIC Rif Wind", berth: "Q2" },
      { vessel: "SYNTHETIC Atlas Pearl", berth: "Q4" },
    ],
    objective: { total_waiting_h: 3.0, berth_utilization_pct: 74 },
    assumptions: [`${SYNTHETIC_TAG} Small instance (3 vessels) solved to proven optimality.`, "Draft constraints respected; no tidal window modeled."],
    offsetH: -29,
  },
  {
    id: "seed-berth-003", name: `${SYNTHETIC_TAG} Weekly deep-sea mix — heuristic`, inputHash: "seed-berth-input-003",
    solver: "greedy + local search", provenOptimal: 0,
    vessels: [
      { name: "SYNTHETIC Atlantic Star", loa_m: 366, draft_m: 14.5, teu: 12000 },
      { name: "SYNTHETIC Chabab Hope", loa_m: 294, draft_m: 13.8, teu: 8200 },
      { name: "SYNTHETIC Souss Voyager", loa_m: 240, draft_m: 12.0, teu: 4500 },
      { name: "SYNTHETIC Rif Wind", loa_m: 172, draft_m: 10.2, teu: 1800 },
      { name: "SYNTHETIC Atlas Pearl", loa_m: 149, draft_m: 9.4, teu: 1100 },
      { name: "SYNTHETIC Gharb Trader", loa_m: 188, draft_m: 10.8, teu: 2300 },
    ],
    assignments: [
      { vessel: "SYNTHETIC Atlantic Star", berth: "Q1" },
      { vessel: "SYNTHETIC Chabab Hope", berth: "Q2" },
      { vessel: "SYNTHETIC Souss Voyager", berth: "Q3" },
      { vessel: "SYNTHETIC Rif Wind", berth: "Q4" },
      { vessel: "SYNTHETIC Atlas Pearl", berth: "Q5" },
      { vessel: "SYNTHETIC Gharb Trader", berth: "Q6" },
    ],
    objective: { total_waiting_h: 11.5, berth_utilization_pct: 81 },
    assumptions: [`${SYNTHETIC_TAG} Heuristic plan; optimality NOT proven.`, "Too large for exact solver in demo time budget; greedy seed + local search."],
    offsetH: -28,
  },
  {
    id: "seed-berth-004", name: `${SYNTHETIC_TAG} Storm recovery sequence — heuristic`, inputHash: "seed-berth-input-004",
    solver: "simulated annealing", provenOptimal: 0,
    vessels: [
      { name: "SYNTHETIC Atlantic Star", loa_m: 366, draft_m: 14.5, teu: 12000 },
      { name: "SYNTHETIC Chabab Hope", loa_m: 294, draft_m: 13.8, teu: 8200 },
      { name: "SYNTHETIC Souss Voyager", loa_m: 240, draft_m: 12.0, teu: 4500 },
      { name: "SYNTHETIC Rif Wind", loa_m: 172, draft_m: 10.2, teu: 1800 },
      { name: "SYNTHETIC Atlas Pearl", loa_m: 149, draft_m: 9.4, teu: 1100 },
    ],
    assignments: [
      { vessel: "SYNTHETIC Chabab Hope", berth: "Q1" },
      { vessel: "SYNTHETIC Atlantic Star", berth: "Q2" },
      { vessel: "SYNTHETIC Souss Voyager", berth: "Q3" },
      { vessel: "SYNTHETIC Rif Wind", berth: "Q4" },
      { vessel: "SYNTHETIC Atlas Pearl", berth: "Q5" },
    ],
    objective: { total_waiting_h: 14.0, berth_utilization_pct: 79 },
    assumptions: [`${SYNTHETIC_TAG} Heuristic plan; optimality NOT proven.`, "Re-planned after a 9h weather window; priority to delayed deep-sea vessels."],
    offsetH: -27.5,
  },
  {
    id: "seed-berth-005", name: `${SYNTHETIC_TAG} Feeder rotation — heuristic`, inputHash: "seed-berth-input-005",
    solver: "genetic algorithm", provenOptimal: 0,
    vessels: [
      { name: "SYNTHETIC Rif Wind", loa_m: 172, draft_m: 10.2, teu: 1800 },
      { name: "SYNTHETIC Atlas Pearl", loa_m: 149, draft_m: 9.4, teu: 1100 },
      { name: "SYNTHETIC Gharb Trader", loa_m: 188, draft_m: 10.8, teu: 2300 },
      { name: "SYNTHETIC Loukkos Spirit", loa_m: 165, draft_m: 9.8, teu: 1600 },
    ],
    assignments: [
      { vessel: "SYNTHETIC Gharb Trader", berth: "Q4" },
      { vessel: "SYNTHETIC Rif Wind", berth: "Q5" },
      { vessel: "SYNTHETIC Loukkos Spirit", berth: "Q6" },
      { vessel: "SYNTHETIC Atlas Pearl", berth: "Q7" },
    ],
    objective: { total_waiting_h: 6.5, berth_utilization_pct: 71 },
    assumptions: [`${SYNTHETIC_TAG} Heuristic plan; optimality NOT proven.`, "Feeder vessels only; turnaround target under 12h each."],
    offsetH: -27,
  },
];

interface SimDef {
  id: string;
  scenario: string;
  inputHash: string;
  seed: number;
  kpis: Record<string, number>;
  assumptions: string[];
  offsetH: number;
}

const SIMS: SimDef[] = [
  { id: "seed-sim-001", scenario: "Baseline day shift", inputHash: "seed-sim-input-001", seed: 42,
    kpis: { avg_truck_turnaround_min: 38, gate_throughput_per_h: 96, berth_utilization_pct: 72, max_gate_queue: 12 },
    assumptions: [`${SYNTHETIC_TAG} Simulated, NOT calibrated to real data.`, "Nominal arrivals; 4 quay cranes; 6 gate lanes."],
    offsetH: -26 },
  { id: "seed-sim-002", scenario: "Peak-season congestion surge", inputHash: "seed-sim-input-002", seed: 7,
    kpis: { avg_truck_turnaround_min: 71, gate_throughput_per_h: 118, berth_utilization_pct: 91, max_gate_queue: 46 },
    assumptions: [`${SYNTHETIC_TAG} Simulated, NOT calibrated to real data.`, "Arrival rate +60% vs baseline; overflow parking activated."],
    offsetH: -25.5 },
  { id: "seed-sim-003", scenario: "Quay crane outage (1 of 4)", inputHash: "seed-sim-input-003", seed: 1234,
    kpis: { avg_truck_turnaround_min: 52, gate_throughput_per_h: 88, berth_utilization_pct: 69, avg_vessel_delay_h: 5.2 },
    assumptions: [`${SYNTHETIC_TAG} Simulated, NOT calibrated to real data.`, "Crane QC-2 down 08:00–16:00; no spare parts delay modeled."],
    offsetH: -25 },
  { id: "seed-sim-004", scenario: "Gate arrival surge (2x)", inputHash: "seed-sim-input-004", seed: 99,
    kpis: { avg_truck_turnaround_min: 64, gate_throughput_per_h: 134, berth_utilization_pct: 70, max_gate_queue: 58 },
    assumptions: [`${SYNTHETIC_TAG} Simulated, NOT calibrated to real data.`, "Doubled arrivals 10:00–14:00; pre-gate staging used."],
    offsetH: -24.6 },
  { id: "seed-sim-005", scenario: "Storm delay (weather window lost)", inputHash: "seed-sim-input-005", seed: 2026,
    kpis: { avg_truck_turnaround_min: 44, gate_throughput_per_h: 72, berth_utilization_pct: 55, berth_idle_h: 9.0 },
    assumptions: [`${SYNTHETIC_TAG} Simulated, NOT calibrated to real data.`, "9h weather closure; recovery plan required on reopening."],
    offsetH: -24.2 },
];

// ---------------------------------------------------------------------------

function main() {
  const db = getDb();

  // Demo accounts — one per role, all sharing one password: SEED_PASSWORD
  // when set, otherwise a random one printed below. Production refuses to
  // seed without an explicit, policy-compliant SEED_PASSWORD.
  const users = [
    { id: "demo-viewer", label: "Yasmine (Viewer)", role: "operations_viewer", email: "viewer@demo.portops.local" },
    { id: "demo-operator", label: "Omar (Operator)", role: "operations_operator", email: "operator@demo.portops.local" },
    { id: "demo-planner", label: "Salma (Planner)", role: "planner", email: "planner@demo.portops.local" },
    { id: "demo-supervisor", label: "Karim (Supervisor)", role: "supervisor", email: "supervisor@demo.portops.local" },
    { id: "demo-admin", label: "Admin (Demo)", role: "administrator", email: "admin@demo.portops.local" },
  ];
  const explicitPassword = process.env.SEED_PASSWORD;
  if (process.env.NODE_ENV === "production" && !explicitPassword) {
    throw new Error("SEED_PASSWORD must be set to seed demo accounts in production.");
  }
  const demoPassword = explicitPassword ?? randomBytes(12).toString("base64url");
  const policy = passwordPolicyError(demoPassword);
  if (policy) throw new Error(`SEED_PASSWORD rejected: ${policy}`);
  const passwordHash = hashPassword(demoPassword);
  const upsertUser = db.prepare(
    "INSERT OR IGNORE INTO users (id, label, role, email, password_hash, password_changed_at) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
  );
  let newUsers = 0;
  for (const u of users) newUsers += Number(upsertUser.run(u.id, u.label, u.role, u.email, passwordHash).changes);

  // Audit entries collected here, sorted chronologically at the end.
  // All ids are seed-stable so INSERT OR IGNORE keeps re-runs idempotent.
  const audits: { action: string; entity: string; entityId: string; actor: string; at: string; detail: object }[] = [];
  const audit = (action: string, entity: string, entityId: string, actor: string, offsetH: number, detail: object) =>
    audits.push({ action, entity, entityId, actor, at: at(offsetH), detail: { synthetic: true, seed: true, ...detail } });

  // ---- Appointments (20) ----
  const insertAppt = db.prepare(
    `INSERT OR IGNORE INTO appointments
     (id, truck_plate, container_no, driver_name, scheduled_at, status, created_by, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let nAppt = 0;
  for (const a of APPTS) {
    const r = insertAppt.run(
      a.id, a.plate, a.container, `${SYNTHETIC_TAG} ${a.driver}`,
      at(a.offsetH), a.status, a.createdBy, `seed-appt-key-${a.plate}`
    );
    if (r.changes > 0) nAppt++;
    audit("appointment.created", "appointment", a.id, a.createdBy, a.offsetH - 36, { status: a.status });
    // Realistic lifecycle transitions (seed-stable; audit only)
    const confirmed = ["confirmed", "checked-in", "completed", "no-show"].includes(a.status);
    if (confirmed) audit("appointment.status_changed", "appointment", a.id, a.createdBy, a.offsetH - 24, { from: "requested", to: "confirmed" });
    if (a.id === "seed-appt-008") {
      // cancelled after being confirmed
      audit("appointment.status_changed", "appointment", a.id, a.createdBy, a.offsetH - 6, { from: "confirmed", to: "cancelled", reason: "customer cancelled" });
    } else if (a.status === "cancelled") {
      audit("appointment.status_changed", "appointment", a.id, a.createdBy, a.offsetH - 6, { from: "requested", to: "cancelled", reason: "customer cancelled" });
    }
    if (["checked-in", "completed"].includes(a.status))
      audit("appointment.status_changed", "appointment", a.id, a.createdBy, a.offsetH - 0.6, { from: "confirmed", to: "checked-in" });
    if (a.status === "completed")
      audit("appointment.status_changed", "appointment", a.id, a.createdBy, a.offsetH + 1, { from: "checked-in", to: "completed" });
    if (a.status === "no-show")
      audit("appointment.status_changed", "appointment", a.id, a.createdBy, a.offsetH + 2, { from: "confirmed", to: "no-show" });
  }

  // ---- Gate verification events (10) ----
  const insertGate = db.prepare(
    `INSERT OR IGNORE INTO gate_verification_events
     (id, appointment_id, simulated, plate_read, container_read, confidence, outcome, reason, verified_by, created_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
  );
  let nGate = 0;
  for (const g of GATES) {
    const r = insertGate.run(g.id, g.apptId, g.plateRead, g.containerRead, g.confidence, g.outcome, g.reason, g.verifiedBy, at(g.offsetH));
    if (r.changes > 0) nGate++;
    audit("gate.scan_recorded", "gate_verification_event", g.id, g.verifiedBy, g.offsetH, { outcome: g.outcome });
  }

  // ---- Review queue (3) ----
  const insertReview = db.prepare(
    `INSERT OR IGNORE INTO review_items
     (id, event_id, status, decided_by, decided_at, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const gateById = new Map(GATES.map((g) => [g.id, g]));
  let nReview = 0;
  for (const rv of REVIEWS) {
    const r = insertReview.run(rv.id, rv.gateId, rv.status, rv.decidedBy, rv.offsetH !== null ? at(rv.offsetH) : null, rv.note, at(gateById.get(rv.gateId)!.offsetH + 0.05));
    if (r.changes > 0) nReview++;
    if (rv.status !== "pending" && rv.decidedBy && rv.offsetH !== null)
      audit("review.decided", "review_item", rv.id, rv.decidedBy, rv.offsetH, { decision: rv.status });
  }

  // ---- Berth plans (5) ----
  const insertPlan = db.prepare(
    `INSERT OR IGNORE INTO berth_plans
     (id, name, input_hash, solver, proven_optimal, result_json, assumptions, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let nPlan = 0;
  for (const p of BERTH_PLANS) {
    const result = {
      synthetic: true,
      solver: p.solver,
      proven_optimal: p.provenOptimal === 1,
      vessels: p.vessels.map((v) => ({ ...v, eta: at(p.offsetH + 4), etd: at(p.offsetH + 16) })),
      assignments: p.assignments,
      objective: p.objective,
      provenance: "synthetic-demo",
    };
    const r = insertPlan.run(p.id, p.name, p.inputHash, p.solver, p.provenOptimal, JSON.stringify(result), JSON.stringify(p.assumptions), "demo-planner", at(p.offsetH));
    if (r.changes > 0) nPlan++;
    audit("berth_plan.created", "berth_plan", p.id, "demo-planner", p.offsetH, { solver: p.solver, proven_optimal: p.provenOptimal === 1 });
  }

  // ---- Simulation runs (5) ----
  const insertSim = db.prepare(
    `INSERT OR IGNORE INTO simulation_runs
     (id, scenario_name, input_hash, seed, result_json, assumptions, calibrated, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
  );
  let nSim = 0;
  for (const s of SIMS) {
    const result = { synthetic: true, status: "completed", scenario: s.scenario, seed: s.seed, kpis: s.kpis, provenance: "simulated" };
    const r = insertSim.run(s.id, `${SYNTHETIC_TAG} ${s.scenario}`, s.inputHash, s.seed, JSON.stringify(result), JSON.stringify(s.assumptions), "demo-planner", at(s.offsetH));
    if (r.changes > 0) nSim++;
    audit("simulation_run.created", "simulation_run", s.id, "demo-planner", s.offsetH, { scenario: s.scenario });
  }

  // ---- Audit events: chronological, stable ids ----
  audits.sort((a, b) => a.at.localeCompare(b.at));
  const insertAudit = db.prepare(
    `INSERT OR IGNORE INTO audit_events (id, actor_id, action, entity, entity_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  let nAudit = 0;
  audits.forEach((e, i) => {
    const r = insertAudit.run(`seed-audit-${String(i + 1).padStart(3, "0")}`, e.actor, e.action, e.entity, e.entityId, JSON.stringify(e.detail), e.at);
    if (r.changes > 0) nAudit++;
  });

  console.log(`seeded ${newUsers} new demo accounts (${users.map((u) => u.email).join(", ")})`);
  if (newUsers > 0 && !explicitPassword) {
    console.log(`demo account password (shown once): ${demoPassword}`);
  }
  console.log(`seeded ${nAppt} appointments, ${nGate} gate events, ${nReview} review items, ${nPlan} berth plans, ${nSim} simulation runs, ${nAudit} audit events`);
  console.log("done. All records labeled synthetic.");
}

main();
