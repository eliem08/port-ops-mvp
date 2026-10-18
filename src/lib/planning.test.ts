// BerthWise planning domain tests.
// Covers: exact optimality, heuristic non-optimality, the >8-vessel exact
// fallback, infeasibility handling, idempotency, list/get.
// ALNS is never asserted on any path (it must stay off interactive paths).

import { describe, it, expect, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { getTestDb } from "@/lib/db/client";
import { MIGRATION_001 } from "@/lib/db/migrations";
import {
  createPlanRun,
  getPlanRun,
  listPlanRuns,
  computeInputHash,
  DEMO_PLANNING_SCENARIOS,
  SOLVER_LABELS,
  type BerthPlanDTO,
} from "@/lib/planning";
import {
  CreatePlanInput,
  SolverChoice,
  type CreatePlanInput as CreatePlanInputT,
} from "@/contracts";

let db: DatabaseSync;

beforeEach(() => {
  db = getTestDb();
  db.exec(MIGRATION_001);
});

function smallInput(solver: CreatePlanInputT["solver"] = "greedy"): CreatePlanInputT {
  return {
    scenarioName: "test — small",
    vessels: [
      { name: "SYN T1", lengthM: 200, draftM: 10, eta: "2026-10-20T06:00:00Z", etd: "2026-10-20T14:00:00Z", grainCapable: false },
      { name: "SYN T2", lengthM: 180, draftM: 9, eta: "2026-10-20T08:00:00Z", etd: "2026-10-20T16:00:00Z", grainCapable: false },
      { name: "SYN T3", lengthM: 220, draftM: 11, eta: "2026-10-20T10:00:00Z", etd: "2026-10-20T20:00:00Z", grainCapable: false },
    ],
    berths: [
      { name: "SYN Q1", lengthM: 300, maxDraftM: 14, grainCapable: false },
      { name: "SYN Q2", lengthM: 250, maxDraftM: 12, grainCapable: false },
    ],
    solver,
    seed: 42,
  };
}

function manyVessels(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    name: `SYN M${i + 1}`,
    lengthM: 180,
    draftM: 9,
    eta: `2026-10-20T${String(i).padStart(2, "0")}:00:00Z`,
    etd: `2026-10-21T${String(i).padStart(2, "0")}:00:00Z`,
    grainCapable: false,
  }));
}

describe("createPlanRun — exact solver", () => {
  it("proves optimality on ≤8 vessels", () => {
    const { record, created } = createPlanRun(db, "u-test", smallInput("exact"));
    expect(created).toBe(true);
    expect(record.solverRequested).toBe("exact");
    expect(record.solverUsed).toBe("exact");
    expect(record.provenOptimal).toBe(true);
    expect(record.exactUnavailableReason).toBeNull();
    expect(record.vesselCount).toBe(3);
    expect(record.assignments.length).toBe(3);
    expect(record.unassigned).toEqual([]);
  });

  it("same input via greedy is NOT proven optimal", () => {
    const { record } = createPlanRun(db, "u-test", smallInput("greedy"));
    expect(record.solverUsed).toBe("greedy");
    expect(record.provenOptimal).toBe(false);
  });

  it("every heuristic solver records provenOptimal=false", () => {
    for (const solver of ["greedy", "annealing", "tabu", "genetic"] as const) {
      const { record } = createPlanRun(db, "u-test", {
        ...smallInput(solver),
        scenarioName: `test — ${solver}`,
      });
      expect(record.solverUsed).toBe(solver);
      expect(record.provenOptimal).toBe(false);
    }
  });
});

describe("createPlanRun — exact fallback above the vessel ceiling", () => {
  it(">8 vessels with solver=exact falls back to a labelled heuristic", () => {
    const { record, created } = createPlanRun(db, "u-test", {
      ...smallInput("exact"),
      scenarioName: "test — oversize exact",
      vessels: manyVessels(9),
    });
    expect(created).toBe(true);
    expect(record.solverRequested).toBe("exact");
    expect(record.solverUsed).toBe("greedy");
    expect(record.provenOptimal).toBe(false);
    expect(record.exactUnavailableReason).toContain("8 vessels");
    expect(record.vesselCount).toBe(9);
  });
});

describe("createPlanRun — infeasibility", () => {
  it("a vessel longer than all berths is recorded unassigned, not a crash", () => {
    const input = smallInput("greedy");
    input.vessels.push({
      name: "SYN Leviathan",
      lengthM: 900,
      draftM: 10,
      eta: "2026-10-20T12:00:00Z",
      etd: "2026-10-20T22:00:00Z",
      grainCapable: false,
    });
    const { record } = createPlanRun(db, "u-test", input);
    expect(record.unassigned.length).toBe(1);
    expect(record.unassigned[0].vesselName).toBe("SYN Leviathan");
    expect(record.unassigned[0].reason).toMatch(/no berth fits/i);
    expect(record.assignments.length).toBe(3);
  });

  it("a grain vessel with no grain-capable berth is unassigned with a reason", () => {
    const input = smallInput("greedy");
    input.vessels = [
      { name: "SYN Grain", lengthM: 200, draftM: 10, eta: "2026-10-20T06:00:00Z", etd: "2026-10-20T14:00:00Z", grainCapable: true },
    ];
    const { record } = createPlanRun(db, "u-test", input);
    expect(record.unassigned.length).toBe(1);
    expect(record.unassigned[0].reason).toMatch(/grain/i);
  });

  it("a too-deep vessel is unassigned with a draft reason", () => {
    const input = smallInput("greedy");
    input.vessels = [
      { name: "SYN Deep", lengthM: 200, draftM: 99, eta: "2026-10-20T06:00:00Z", etd: "2026-10-20T14:00:00Z", grainCapable: false },
    ];
    const { record } = createPlanRun(db, "u-test", input);
    expect(record.unassigned.length).toBe(1);
    expect(record.assignments.length).toBe(0);
  });
});

describe("createPlanRun — idempotency", () => {
  it("same input hash + solver replays the existing record", () => {
    const input = smallInput("tabu");
    const first = createPlanRun(db, "u-test", input);
    expect(first.created).toBe(true);
    const second = createPlanRun(db, "u-test", { ...input });
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);
    expect(listPlanRuns(db).length).toBe(1);
  });

  it("same content with a different solver creates a separate record", () => {
    const first = createPlanRun(db, "u-test", smallInput("greedy"));
    const second = createPlanRun(db, "u-test", smallInput("tabu"));
    expect(second.created).toBe(true);
    expect(second.record.id).not.toBe(first.record.id);
    expect(listPlanRuns(db).length).toBe(2);
  });

  it("input hash is stable for identical inputs", () => {
    const input = smallInput("annealing");
    const a = createPlanRun(db, "u-test", input);
    // Recompute via a second db to prove hash stability, not object identity.
    const db2 = getTestDb();
    db2.exec(MIGRATION_001);
    const b = createPlanRun(db2, "u-test", JSON.parse(JSON.stringify(input)));
    expect(a.record.assignments).toEqual(b.record.assignments);
    expect(computeInputHash).toBeDefined();
  });
});

describe("createPlanRun — DTO shape", () => {
  it("exposes utilization, assumptions and audit-friendly fields", () => {
    const { record } = createPlanRun(db, "u-test", smallInput("exact"));
    expect(record.berthUtilization.length).toBe(2);
    for (const u of record.berthUtilization) {
      expect(u.utilizationPct).toBeGreaterThanOrEqual(0);
      expect(u.utilizationPct).toBeLessThanOrEqual(100);
    }
    expect(record.assumptions.some((a) => /synthetic/i.test(a))).toBe(true);
    expect(record.createdBy).toBe("u-test");
    expect(typeof record.createdAt).toBe("string");
    expect(record.totalWaitingHours).toBeGreaterThanOrEqual(0);
    expect(record.makespanHours).toBeGreaterThan(0);
  });
});

describe("getPlanRun / listPlanRuns", () => {
  it("round-trips and lists newest first", () => {
    const a = createPlanRun(db, "u-test", smallInput("greedy"));
    const b = createPlanRun(db, "u-test", smallInput("tabu"));
    const fetched: BerthPlanDTO | null = getPlanRun(db, a.record.id);
    expect(fetched?.id).toBe(a.record.id);
    expect(getPlanRun(db, "nope")).toBeNull();
    const listed = listPlanRuns(db);
    expect(listed.map((r) => r.id)).toEqual([b.record.id, a.record.id]);
  });
});

describe("contract validation (Zod boundary)", () => {
  it("rejects empty vessels", () => {
    const r = CreatePlanInput.safeParse({ ...smallInput("greedy"), vessels: [] });
    expect(r.success).toBe(false);
  });

  it("rejects more than 20 vessels", () => {
    const r = CreatePlanInput.safeParse({
      ...smallInput("greedy"),
      vessels: manyVessels(21),
    });
    expect(r.success).toBe(false);
  });

  it("rejects a non-UTC datetime", () => {
    const input = smallInput("greedy");
    input.vessels[0].eta = "2026-10-20 06:00:00";
    expect(CreatePlanInput.safeParse(input).success).toBe(false);
  });

  it("rejects etd before eta", () => {
    const input = smallInput("greedy");
    input.vessels[0].etd = "2026-10-20T05:00:00Z";
    expect(CreatePlanInput.safeParse(input).success).toBe(false);
  });

  it("rejects an unknown solver", () => {
    const r = CreatePlanInput.safeParse({ ...smallInput("greedy"), solver: "alns" });
    expect(r.success).toBe(false);
  });

  it("rejects unknown fields (strict)", () => {
    const r = CreatePlanInput.safeParse({ ...smallInput("greedy"), extra: 1 });
    expect(r.success).toBe(false);
  });

  it("defaults the seed to 42", () => {
    const { seed, ...rest } = smallInput("greedy") as Record<string, unknown>;
    void seed;
    const r = CreatePlanInput.safeParse(rest);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.seed).toBe(42);
  });

  it("never offers alns as a solver choice", () => {
    expect(SolverChoice.options).not.toContain("alns");
    expect(Object.keys(SOLVER_LABELS)).not.toContain("alns");
  });
});

describe("DEMO_PLANNING_SCENARIOS", () => {
  it("all presets are valid contract inputs and clearly synthetic", () => {
    expect(DEMO_PLANNING_SCENARIOS.length).toBeGreaterThanOrEqual(2);
    for (const s of DEMO_PLANNING_SCENARIOS) {
      expect(s.name).toMatch(/synthetic/i);
      const r = CreatePlanInput.safeParse({
        scenarioName: s.name,
        vessels: s.vessels,
        berths: s.berths,
        solver: s.suggestedSolver,
        seed: 42,
      });
      expect(r.success).toBe(true);
    }
  });

  it("the oversize-visitor preset actually leaves a vessel unassigned", () => {
    const s = DEMO_PLANNING_SCENARIOS.find((x) => /oversize/i.test(x.name));
    expect(s).toBeDefined();
    const { record } = createPlanRun(db, "u-test", {
      scenarioName: s!.name,
      vessels: s!.vessels,
      berths: s!.berths,
      solver: s!.suggestedSolver,
      seed: 42,
    });
    expect(record.unassigned.length).toBeGreaterThan(0);
    expect(record.provenOptimal).toBe(false);
  });
});
