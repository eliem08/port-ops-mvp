// PortTwin simulation domain tests — reproducibility, validation,
// idempotency, provenance labeling, compare.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "@/lib/db/migrations";

// @/lib/simulation pulls route-helpers → @/lib/auth → db/client, which
// value-imports the "node:sqlite" builtin. That specifier resolves fine in
// the Next.js runtime but vite-node fails to resolve it, so cut the chain
// here: the tests below never exercise auth.
vi.mock("@/lib/auth", () => ({
  jsonError: () => {
    throw new Error("jsonError is mocked out in simulation tests");
  },
}));
import {
  createSimulationRun,
  getSimulationRun,
  listSimulationRuns,
  compareSimulationRuns,
  buildSimulationInput,
  toSimulationRunDTO,
  DEMO_SIMULATION_SCENARIOS,
  UNCALIBRATED_NOTICE,
  SimulationValidationError,
  SimulationNotFoundError,
} from "@/lib/simulation";
import { CreateSimulationInput } from "@/contracts";
import {
  runScenario,
  clearRunCache,
} from "@/vendored/porttwin/sim/service";
import { inputHash } from "@/vendored/porttwin/sim/contracts";

function freshDb(): DatabaseSync {
  // process.getBuiltinModule bypasses vite-node's static "node:sqlite"
  // specifier handling (it strips the prefix and fails to resolve).
  const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const m of MIGRATIONS) db.exec(m.sql);
  return db;
}

const BASE_INPUT = {
  scenarioName: "Crisis baseline",
  scenarioId: "crisis",
  seed: 42,
  replications: 10,
} as const;

describe("DEMO_SIMULATION_SCENARIOS", () => {
  it("exposes the three vendored presets as synthetic scenarios", () => {
    expect(DEMO_SIMULATION_SCENARIOS.map((s) => s.id)).toEqual([
      "crisis",
      "tas",
      "tas-night",
    ]);
    for (const s of DEMO_SIMULATION_SCENARIOS) {
      expect(s.synthetic).toBe(true);
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });
});

describe("CreateSimulationInput contract", () => {
  it("accepts a valid input, applying seed/replication defaults when omitted", () => {
    const parsed = CreateSimulationInput.safeParse(BASE_INPUT);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.seed).toBe(42);
      expect(parsed.data.replications).toBe(10); // explicit in BASE_INPUT
    }
    const withDefaults = CreateSimulationInput.safeParse({
      scenarioName: "x",
      scenarioId: "crisis",
    });
    expect(withDefaults.success).toBe(true);
    if (withDefaults.success) {
      expect(withDefaults.data.seed).toBe(42);
      expect(withDefaults.data.replications).toBe(100);
    }
  });

  it("rejects an unknown scenarioId", () => {
    const parsed = CreateSimulationInput.safeParse({
      ...BASE_INPUT,
      scenarioId: "moon-base",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects replications outside 10–500", () => {
    expect(
      CreateSimulationInput.safeParse({ ...BASE_INPUT, replications: 5 }).success
    ).toBe(false);
    expect(
      CreateSimulationInput.safeParse({ ...BASE_INPUT, replications: 501 }).success
    ).toBe(false);
    expect(
      CreateSimulationInput.safeParse({ ...BASE_INPUT, replications: 100 })
        .success
    ).toBe(true);
  });

  it("rejects a non-integer seed type", () => {
    expect(
      CreateSimulationInput.safeParse({ ...BASE_INPUT, seed: "abc" }).success
    ).toBe(false);
    expect(
      CreateSimulationInput.safeParse({ ...BASE_INPUT, seed: 4.5 }).success
    ).toBe(false);
  });

  it("rejects unknown override keys (strict)", () => {
    const parsed = CreateSimulationInput.safeParse({
      ...BASE_INPUT,
      paramOverrides: { evilParam: 1 },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an over-long idempotency key", () => {
    const parsed = CreateSimulationInput.safeParse({
      ...BASE_INPUT,
      idempotencyKey: "x".repeat(65),
    });
    expect(parsed.success).toBe(false);
  });
});

describe("createSimulationRun", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = freshDb();
    clearRunCache();
  });

  it("creates a completed run with simulated KPIs and uncalibrated assumptions", () => {
    const { record, created } = createSimulationRun(db, "u-planner", {
      ...BASE_INPUT,
    });
    expect(created).toBe(true);
    expect(record.status).toBe("completed");
    expect(record.scenarioId).toBe("crisis");
    expect(record.seed).toBe(42);
    expect(record.replications).toBe(10);
    expect(record.calibrated).toBe(false);
    expect(record.inputHash).toMatch(/^[0-9a-f]{16}$/);

    // KPI figures are provenance-labeled "simulated".
    expect(record.kpis.length).toBeGreaterThan(0);
    for (const k of record.kpis) {
      expect(k.provenance).toBe("simulated");
      expect(k.provenance).not.toBe("measured");
    }
    const wait = record.kpis.find((k) => k.key === "meanWaitMin");
    expect(wait).toBeDefined();
    expect(typeof wait!.value).toBe("number");

    // Scenario parameters are provenance-labeled "assumed".
    expect(record.parameters.length).toBeGreaterThan(0);
    for (const p of record.parameters) {
      expect(p.provenance).toBe("assumed");
      expect(p.provenance).not.toBe("measured");
    }

    // Assumptions carry the synthetic + uncalibrated notices.
    expect(record.assumptions).toContain("SYNTHETIC demo data");
    expect(record.assumptions).toContain("UNCALIBRATED model");
    expect(record.assumptions).toContain(UNCALIBRATED_NOTICE);
  });

  it("is reproducible: same input → identical result_json", () => {
    const first = createSimulationRun(db, "u-planner", { ...BASE_INPUT });
    const second = createSimulationRun(db, "u-planner", { ...BASE_INPUT });
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);

    const rowOf = (id: string) =>
      db
        .prepare("SELECT result_json FROM simulation_runs WHERE id = ?")
        .get(id) as { result_json: string };
    expect(rowOf(second.record.id).result_json).toBe(
      rowOf(first.record.id).result_json
    );
  });

  it("is deterministic at the engine level (fixed seed, cache bypassed)", () => {
    const a = runScenario(
      buildSimulationInput("tas", 7, 10, {}),
      { idempotencyKey: "det-a" }
    );
    const b = runScenario(
      buildSimulationInput("tas", 7, 10, {}),
      { idempotencyKey: "det-b" }
    );
    const { completedAtUtc: _ca, ...restA } = a;
    const { completedAtUtc: _cb, ...restB } = b;
    expect(restA).toEqual(restB);
    expect(inputHash(buildSimulationInput("tas", 7, 10, {}))).toBe(a.inputHash);
  });

  it("returns the existing record on idempotent replay (created=false)", () => {
    const first = createSimulationRun(db, "u-planner", {
      ...BASE_INPUT,
      idempotencyKey: "replay-key-1",
    });
    const second = createSimulationRun(db, "u-planner", {
      ...BASE_INPUT,
      idempotencyKey: "replay-key-1",
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM simulation_runs").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(1);
  });

  it("treats a different seed as a different run", () => {
    const first = createSimulationRun(db, "u-planner", { ...BASE_INPUT });
    const second = createSimulationRun(db, "u-planner", {
      ...BASE_INPUT,
      seed: 43,
    });
    expect(second.created).toBe(true);
    expect(second.record.id).not.toBe(first.record.id);
  });

  it("applies numeric param overrides", () => {
    const { record } = createSimulationRun(db, "u-planner", {
      ...BASE_INPUT,
      paramOverrides: { numGates: 4, horizonHours: 12 },
    });
    const gates = record.parameters.find((p) => p.key === "numGates");
    const horizon = record.parameters.find((p) => p.key === "simHours");
    expect(gates?.value).toBe(4);
    expect(horizon?.value).toBe(12);
  });

  it("throws SimulationValidationError (400) for an unknown scenarioId", () => {
    expect(() =>
      createSimulationRun(db, "u-planner", {
        ...BASE_INPUT,
        scenarioId: "moon-base",
      })
    ).toThrowError(SimulationValidationError);
    try {
      createSimulationRun(db, "u-planner", {
        ...BASE_INPUT,
        scenarioId: "moon-base",
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SimulationValidationError);
      expect((err as SimulationValidationError).status).toBe(400);
      expect((err as SimulationValidationError).publicError.message).toContain(
        "moon-base"
      );
    }
  });

  it("lists runs newest-first and gets by id", () => {
    const first = createSimulationRun(db, "u-planner", { ...BASE_INPUT });
    const second = createSimulationRun(db, "u-planner", {
      ...BASE_INPUT,
      seed: 43,
    });
    const list = listSimulationRuns(db);
    expect(list.map((r) => r.id)).toEqual([second.record.id, first.record.id]);

    const got = getSimulationRun(db, first.record.id);
    expect(got?.id).toBe(first.record.id);
    expect(getSimulationRun(db, "nope")).toBeNull();
  });

  it("toSimulationRunDTO never reports calibrated=true", () => {
    const { record } = createSimulationRun(db, "u-planner", { ...BASE_INPUT });
    expect(record.calibrated).toBe(false);
    // Even a hand-tampered row (calibrated=1) must not surface as calibrated.
    db.prepare("UPDATE simulation_runs SET calibrated = 1 WHERE id = ?").run(
      record.id
    );
    expect(getSimulationRun(db, record.id)?.calibrated).toBe(false);
  });
});

describe("compareSimulationRuns", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = freshDb();
    clearRunCache();
  });

  it("returns both DTOs and a correct delta table (B − A)", () => {
    const a = createSimulationRun(db, "u-planner", { ...BASE_INPUT });
    const b = createSimulationRun(db, "u-planner", {
      ...BASE_INPUT,
      scenarioId: "tas",
      scenarioName: "TAS intervention",
    });
    const cmp = compareSimulationRuns(db, a.record.id, b.record.id);
    expect(cmp.a.id).toBe(a.record.id);
    expect(cmp.b.id).toBe(b.record.id);
    expect(cmp.deltas.length).toBe(cmp.a.kpis.length);
    for (const d of cmp.deltas) {
      const ka = cmp.a.kpis.find((k) => k.key === d.key)!;
      const kb = cmp.b.kpis.find((k) => k.key === d.key)!;
      expect(d.a).toBe(ka.value);
      expect(d.b).toBe(kb.value);
      expect(d.delta).toBeCloseTo(
        (kb.value as number) - (ka.value as number),
        10
      );
    }
  });

  it("throws SimulationNotFoundError for an unknown id", () => {
    const a = createSimulationRun(db, "u-planner", { ...BASE_INPUT });
    expect(() =>
      compareSimulationRuns(db, a.record.id, "does-not-exist")
    ).toThrowError(SimulationNotFoundError);
    expect(() =>
      compareSimulationRuns(db, "does-not-exist", a.record.id)
    ).toThrowError(SimulationNotFoundError);
  });

  it("round-trips through toSimulationRunDTO without measured provenance", () => {
    const { record } = createSimulationRun(db, "u-planner", { ...BASE_INPUT });
    const row = db
      .prepare("SELECT * FROM simulation_runs WHERE id = ?")
      .get(record.id) as unknown as Parameters<typeof toSimulationRunDTO>[0];
    const dto = toSimulationRunDTO(row);
    const provenances = [...dto.kpis, ...dto.parameters].map((f) => f.provenance);
    expect(provenances).not.toContain("measured");
  });
});
