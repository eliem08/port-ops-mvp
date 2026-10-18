// Integration test: the one complete cross-module demo workflow.
//
// appointment (TAS) → simulated gate scan (GateWatch, server-side
// authoritative state) → human review → supervisor decision → EXPLICIT
// appointment-volume bridge → PortTwin simulation (proposed run) →
// baseline vs proposed comparison.
//
// The test drives the SAME domain functions the UI server actions
// delegate to (src/lib/demo-workflow.ts), so the tested path IS the
// shipped path. No automatic feeds: the bridge assumptions are explicit,
// operator-editable, and stored verbatim on the proposed run.

import { describe, it, expect, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { freshTestDb } from "@/test-utils/route-harness";
import { createAppointment, setAppointmentStatus } from "./appointments";
import {
  recordScanVerification,
  decideReviewItem,
  appointmentVolumeSummary,
  proposeSimulationBridge,
} from "./demo-workflow";
import {
  createSimulationRun,
  compareSimulationRuns,
} from "./simulation";

let db: DatabaseSync;
let todayStr: string;

beforeEach(() => {
  db = freshTestDb();
  todayStr = new Date().toISOString().slice(0, 10);
});

const SCAN_DATE = new Date().toISOString();

function makeAppointment(plate: string, container: string | null = null) {
  const { record } = createAppointment(db, "u-operator", {
    truckPlate: plate,
    containerNo: container,
    driverName: null,
    scheduledAt: SCAN_DATE,
  });
  return record;
}

describe("cross-module workflow: appointments → gate → review → bridge → simulation", () => {
  it("runs the full chain and compares baseline vs proposed", async () => {
    // 1. Create two truck appointments (TAS).
    const a1 = makeAppointment("BR-1", "TCLU1000011");
    const a2 = makeAppointment("BR-2", "TCLU1000022");

    // 2a. Confirm the first, then submit a simulated scan with the server's
    //     authoritative appointment state: matching reads, high confidence
    //     → auto-accept, no review item.
    setAppointmentStatus(db, a1.id, "confirmed");
    const accepted = await recordScanVerification(db, "u-operator", {
      appointmentId: a1.id,
      plateRead: "BR-1",
      containerRead: "TCLU1000011",
      confidence: 95,
    });
    expect(accepted.outcome).toBe("auto-accept");
    expect(accepted.reviewId).toBeNull();

    // 2b. The second appointment is still 'requested' and the scan has low
    //     confidence → routed to human review (never auto-accepted).
    const uncertain = await recordScanVerification(db, "u-operator", {
      appointmentId: a2.id,
      plateRead: "BR-2",
      containerRead: "TCLU1000022",
      confidence: 40,
    });
    expect(uncertain.outcome).toBe("human-review");
    expect(uncertain.reviewId).not.toBeNull();

    // 3-4. Supervisor records the decision on the review item + it is final.
    const decided = decideReviewItem(
      db,
      uncertain.reviewId!,
      "u-supervisor",
      "approved",
      "grainy camera frame, plate legible on second look"
    );
    expect(decided.status).toBe("approved");
    expect(decided.eventId).toBe(uncertain.eventId);
    expect(() =>
      decideReviewItem(db, uncertain.reviewId!, "u-supervisor", "approved", "again")
    ).toThrow(/already approved/);

    // 5. Explicit bridge: summarize appointment volume for today, propose
    //    simulation overrides. The derivation is visible in the assumptions.
    const summary = appointmentVolumeSummary(db, todayStr);
    expect(summary.total).toBe(2);
    expect(summary.booked).toBe(2);

    const proposal = proposeSimulationBridge(summary);
    expect(proposal.trucksPerDay).toBe(2);
    expect(proposal.horizonHours).toBe(24);
    const assumptionText = proposal.assumptions.join("\n");
    expect(assumptionText).toContain("APPOINTMENT→SIMULATION BRIDGE");
    expect(assumptionText).toContain(
      "do NOT feed the simulator automatically"
    );
    expect(assumptionText).toContain("LIMIT");

    // 6. Baseline run (preset defaults) vs proposed run (bridge overrides +
    //    explicit assumptions), then compare.
    const baseline = createSimulationRun(db, "u-planner", {
      scenarioName: "baseline — preset defaults",
      scenarioId: "crisis",
      seed: 42,
      replications: 10,
    });
    expect(baseline.created).toBe(true);

    const proposed = createSimulationRun(
      db,
      "u-planner",
      {
        scenarioName: proposal.scenarioName,
        scenarioId: "crisis",
        seed: 42,
        replications: 10,
        paramOverrides: {
          trucksPerDay: proposal.trucksPerDay,
          horizonHours: proposal.horizonHours,
        },
      },
      proposal.assumptions
    );
    expect(proposed.created).toBe(true);
    // The explicit assumptions are stored verbatim, ahead of the engine's.
    expect(proposed.record.assumptions[0]).toContain(
      "APPOINTMENT→SIMULATION BRIDGE"
    );
    expect(proposed.record.assumptions.join("\n")).toContain(
      "do NOT feed the simulator automatically"
    );

    const { deltas } = compareSimulationRuns(
      db,
      baseline.record.id,
      proposed.record.id
    );
    expect(deltas.length).toBeGreaterThan(0);
    for (const d of deltas) {
      expect(d.key).toBeTruthy();
      expect(d.label).toBeTruthy();
    }
  });

  it("never auto-accepts a scan with missing confidence (fail closed)", async () => {
    const a = makeAppointment("BR-9", "TCLU9000009");
    setAppointmentStatus(db, a.id, "confirmed");
    const r = await recordScanVerification(db, "u-operator", {
      appointmentId: a.id,
      plateRead: "BR-9",
      containerRead: "TCLU9000009",
      confidence: null,
    });
    expect(r.outcome).toBe("human-review");
    expect(r.reviewId).not.toBeNull();
  });

  it("zero-volume day proposes trucksPerDay=1 and says so explicitly", () => {
    const summary = appointmentVolumeSummary(db, "2026-01-01");
    expect(summary.total).toBe(0);
    expect(summary.booked).toBe(0);
    const proposal = proposeSimulationBridge(summary);
    expect(proposal.trucksPerDay).toBe(1);
    expect(proposal.assumptions.join("\n")).toContain("Zero-volume day");
  });

  it("cancelled appointments are excluded from the bridge volume", () => {
    const a = makeAppointment("BR-X");
    setAppointmentStatus(db, a.id, "cancelled"); // requested → cancelled
    const summary = appointmentVolumeSummary(db, todayStr);
    expect(summary.total).toBe(1);
    expect(summary.booked).toBe(0);
    expect(summary.byStatus.cancelled).toBe(1);
  });

  it("identical input with different bridge assumptions is a NEW record (no silent replay)", () => {
    const input = {
      scenarioName: "bridge idempotency probe",
      scenarioId: "crisis" as const,
      seed: 42,
      replications: 10,
      paramOverrides: { trucksPerDay: 7, horizonHours: 24 },
    };
    const first = createSimulationRun(db, "u-planner", input, ["bridge A"]);
    expect(first.created).toBe(true);
    // Same input + same assumptions → idempotent replay.
    const replay = createSimulationRun(db, "u-planner", input, ["bridge A"]);
    expect(replay.created).toBe(false);
    expect(replay.record.id).toBe(first.record.id);
    // Same input + DIFFERENT assumptions → new record, nothing hidden.
    const edited = createSimulationRun(db, "u-planner", input, ["bridge B"]);
    expect(edited.created).toBe(true);
    expect(edited.record.assumptions[0]).toBe("bridge B");
  });

  it("rejects a malformed bridge date", () => {
    expect(() => appointmentVolumeSummary(db, "not-a-date")).toThrow(
      /YYYY-MM-DD/
    );
  });
});
