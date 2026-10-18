// BerthWise planning domain logic — shared by the API routes (and directly testable).
// DB rows are snake_case; the DTOs here are camelCase contract shapes.
//
// The vendored solvers are pure and seeded-deterministic. planALNS is
// deliberately NEVER imported here: it is superlinear and unsuitable for
// any interactive path.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import {
  planGreedy,
  planOptimized,
  planTabu,
} from "@/vendored/berthwise/lib/berth";
import { planGA } from "@/vendored/berthwise/lib/ga";
import {
  solveExact,
  EXACT_MAX_VESSELS,
} from "@/vendored/berthwise/lib/exact";
import { assertPlanningInputs } from "@/vendored/berthwise/lib/validate";
import type {
  Vessel,
  Berth,
  BerthPlan,
} from "@/vendored/berthwise/lib/types";
import type {
  SolverChoice,
  CreatePlanInput,
  VesselInput,
  BerthInput,
} from "@/contracts";
import { withTransaction } from "./route-helpers";

// Client-safe data (labels, demo presets) lives in ./planning-data so the
// "New plan" client form can import it without pulling server-only modules.
import {
  SOLVER_LABELS,
  DEMO_PLANNING_SCENARIOS,
  type DemoPlanningScenario,
} from "./planning-data";
// Re-exported so server consumers (routes, pages, tests) have one import site.
export { SOLVER_LABELS, DEMO_PLANNING_SCENARIOS, type DemoPlanningScenario };

/** Thrown for input problems detected below the Zod boundary (→ 400). */
export class PlanningInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanningInputError";
  }
}

/** Wall-clock-derived iteration budget for the iterative heuristics (deterministic per value). */
const HEURISTIC_TIME_LIMIT_MS = 2000;

// ── DTOs ─────────────────────────────────────────────────────────────────

export interface PlanAssignmentDTO {
  vesselId: string;
  vesselName: string;
  berthId: string;
  berthName: string;
  /** ISO 8601 UTC berth start. */
  startAt: string;
  /** ISO 8601 UTC berth end. */
  endAt: string;
  waitingHours: number;
}

export interface BerthUtilizationDTO {
  berthId: string;
  berthName: string;
  busyHours: number;
  /** Busy share of the makespan, 0–100. */
  utilizationPct: number;
  assignments: number;
}

export interface UnassignedVesselDTO {
  vesselId: string;
  vesselName: string;
  reason: string;
}

export interface BerthPlanDTO {
  id: string;
  name: string;
  solverRequested: SolverChoice;
  solverUsed: SolverChoice;
  /** TRUE only when the exact solver ran (≤8 vessels) and proved optimality. */
  provenOptimal: boolean;
  exactUnavailableReason: string | null;
  vesselCount: number;
  assignments: PlanAssignmentDTO[];
  berthUtilization: BerthUtilizationDTO[];
  unassigned: UnassignedVesselDTO[];
  totalWaitingHours: number;
  makespanHours: number;
  assumptions: string[];
  createdBy: string;
  createdAt: string;
}

// ── Input → solver mapping ───────────────────────────────────────────────

interface MappedInstance {
  vessels: Vessel[];
  berths: Berth[];
  /** Scenario start (earliest ETA), ISO UTC. */
  t0: string;
  vesselMeta: Map<string, { name: string; eta: string; etd: string }>;
  berthMeta: Map<string, { name: string; maxDraftM: number }>;
  /** Vessel ids with no feasible berth at all (length/draft/grain). */
  infeasibleVesselIds: Map<string, string>; // vesselId -> reason
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function toSolverVessel(input: VesselInput, id: string, t0ms: number): Vessel {
  const etaMs = Date.parse(input.eta);
  const etdMs = Date.parse(input.etd);
  const handlingHours = Math.max(round3((etdMs - etaMs) / 3_600_000), 0.001);
  return {
    id,
    name: input.name,
    line: "SYNTHETIC",
    etaHours: round3((etaMs - t0ms) / 3_600_000),
    lengthM: input.lengthM,
    draftM: input.draftM,
    cargo: input.grainCapable ? "grain" : "container",
    handlingHours,
    teu: input.grainCapable ? 0 : Math.round(input.lengthM * 8),
    origin: "SYNTHETIC",
  };
}

function toSolverBerth(input: BerthInput, id: string): Berth {
  return {
    id,
    name: input.name,
    lengthM: input.lengthM,
    grainCapable: input.grainCapable,
    // The contract has no crane count; the vendored solver needs one.
    // Fixed synthetic value, disclosed in the run assumptions.
    cranes: 2,
  };
}

/** Contract-level feasibility: length, draft AND grain capability. */
function infeasibilityReason(v: VesselInput, berths: BerthInput[]): string | null {
  const fits = berths.some(
    (b) =>
      v.lengthM <= b.lengthM &&
      v.draftM <= b.maxDraftM &&
      (!v.grainCapable || b.grainCapable)
  );
  if (fits) return null;
  const parts = [`length ${v.lengthM} m`, `draft ${v.draftM} m`];
  if (v.grainCapable) parts.push("grain cargo");
  return `No berth fits this vessel (${parts.join(" / ")}): too long, too deep, or no grain-capable berth.`;
}

function mapInputs(input: CreatePlanInput): MappedInstance {
  const t0ms = Math.min(...input.vessels.map((v) => Date.parse(v.eta)));
  const t0 = new Date(t0ms).toISOString();

  const vessels: Vessel[] = [];
  const vesselMeta = new Map<string, { name: string; eta: string; etd: string }>();
  const infeasibleVesselIds = new Map<string, string>();
  input.vessels.forEach((v, i) => {
    const id = `v${i + 1}`;
    const reason = infeasibilityReason(v, input.berths);
    if (reason) {
      infeasibleVesselIds.set(id, reason);
      return;
    }
    vessels.push(toSolverVessel(v, id, t0ms));
    vesselMeta.set(id, { name: v.name, eta: v.eta, etd: v.etd });
  });

  const berths: Berth[] = [];
  const berthMeta = new Map<string, { name: string; maxDraftM: number }>();
  input.berths.forEach((b, i) => {
    const id = `b${i + 1}`;
    berths.push(toSolverBerth(b, id));
    berthMeta.set(id, { name: b.name, maxDraftM: b.maxDraftM });
  });

  try {
    assertPlanningInputs(vessels, berths);
  } catch (err) {
    throw new PlanningInputError(
      err instanceof Error ? err.message : "invalid planning inputs"
    );
  }

  return { vessels, berths, t0, vesselMeta, berthMeta, infeasibleVesselIds };
}

// ── Solver dispatch ──────────────────────────────────────────────────────

interface SolveOutcome {
  plan: BerthPlan;
  solverUsed: SolverChoice;
  provenOptimal: boolean;
  exactUnavailableReason: string | null;
}

function solve(
  instance: MappedInstance,
  solver: SolverChoice,
  seed: number,
  /** Total vessels in the request — the exact ceiling applies to the input, not the feasible subset. */
  totalVesselCount: number
): SolveOutcome {
  const { vessels, berths } = instance;
  const opts = { seed, timeLimitMs: HEURISTIC_TIME_LIMIT_MS };

  if (solver === "exact") {
    if (totalVesselCount > EXACT_MAX_VESSELS) {
      const reason =
        `Exact solver is limited to ${EXACT_MAX_VESSELS} vessels ` +
        `(received ${totalVesselCount}); fell back to the greedy heuristic. ` +
        `This result is NOT proven optimal.`;
      return {
        plan: planGreedy(vessels, berths, { seed }),
        solverUsed: "greedy",
        provenOptimal: false,
        exactUnavailableReason: reason,
      };
    }
    const result = solveExact(vessels, berths, { seed });
    return {
      plan: result.plan,
      solverUsed: "exact",
      provenOptimal: result.provenOptimal === true,
      exactUnavailableReason: null,
    };
  }

  const plan =
    solver === "greedy"
      ? planGreedy(vessels, berths, { seed })
      : solver === "annealing"
        ? planOptimized(vessels, berths, opts)
        : solver === "tabu"
          ? planTabu(vessels, berths, opts)
          : planGA(vessels, berths, { seed });
  return { plan, solverUsed: solver, provenOptimal: false, exactUnavailableReason: null };
}

// ── Plan → DTO ───────────────────────────────────────────────────────────

interface StoredPlanPayload {
  solverRequested: SolverChoice;
  solverUsed: SolverChoice;
  provenOptimal: boolean;
  exactUnavailableReason: string | null;
  seed: number;
  t0: string;
  vesselCount: number;
  assignments: PlanAssignmentDTO[];
  berthUtilization: BerthUtilizationDTO[];
  unassigned: UnassignedVesselDTO[];
  totalWaitingHours: number;
  makespanHours: number;
  assumptions: string[];
}

function buildPayload(
  input: CreatePlanInput,
  instance: MappedInstance,
  outcome: SolveOutcome
): StoredPlanPayload {
  const t0ms = Date.parse(instance.t0);
  const vesselById = new Map(instance.vessels.map((v) => [v.id, v]));
  const berthName = (id: string) => instance.berthMeta.get(id)?.name ?? id;

  // Defence in depth: the vendored solvers do not know the contract-level
  // maxDraftM, so any assignment that violates it is demoted to unassigned.
  const kept: PlanAssignmentDTO[] = [];
  const demoted: UnassignedVesselDTO[] = [];
  for (const a of outcome.plan.assignments) {
    const vessel = vesselById.get(a.vesselId);
    const maxDraft = instance.berthMeta.get(a.berthId)?.maxDraftM;
    const meta = instance.vesselMeta.get(a.vesselId);
    if (!vessel || !meta) continue;
    if (maxDraft !== undefined && vessel.draftM > maxDraft) {
      demoted.push({
        vesselId: a.vesselId,
        vesselName: meta.name,
        reason:
          `Draft ${vessel.draftM} m exceeds ${berthName(a.berthId)} ` +
          `maximum draft ${maxDraft} m; removed from the solver assignment.`,
      });
      continue;
    }
    kept.push({
      vesselId: a.vesselId,
      vesselName: meta.name,
      berthId: a.berthId,
      berthName: berthName(a.berthId),
      startAt: new Date(t0ms + a.startHours * 3_600_000).toISOString(),
      endAt: new Date(t0ms + a.endHours * 3_600_000).toISOString(),
      waitingHours: round3(a.waitingHours),
    });
  }
  kept.sort((x, y) => x.startAt.localeCompare(y.startAt));

  const unassigned: UnassignedVesselDTO[] = [];
  for (const [vesselId, reason] of instance.infeasibleVesselIds) {
    const idx = Number(vesselId.slice(1)) - 1;
    unassigned.push({
      vesselId,
      vesselName: input.vessels[idx]?.name ?? vesselId,
      reason,
    });
  }
  for (const vesselId of outcome.plan.unassigned) {
    if (unassigned.some((u) => u.vesselId === vesselId)) continue;
    const meta = instance.vesselMeta.get(vesselId);
    unassigned.push({
      vesselId,
      vesselName: meta?.name ?? vesselId,
      reason:
        "The solver could not place this vessel on any feasible berth within the planning horizon.",
    });
  }
  unassigned.push(...demoted);

  // Recompute roll-ups from the final (post-demotion) assignments so the
  // numbers shown always match the assignment table.
  const busyByBerth = new Map<string, { busy: number; count: number }>();
  let totalWaiting = 0;
  let makespan = 0;
  for (const a of kept) {
    const durH = (Date.parse(a.endAt) - Date.parse(a.startAt)) / 3_600_000;
    const entry = busyByBerth.get(a.berthId) ?? { busy: 0, count: 0 };
    entry.busy += durH;
    entry.count += 1;
    busyByBerth.set(a.berthId, entry);
    totalWaiting += a.waitingHours;
    makespan = Math.max(makespan, (Date.parse(a.endAt) - t0ms) / 3_600_000);
  }
  const berthUtilization: BerthUtilizationDTO[] = instance.berths.map((b) => {
    const entry = busyByBerth.get(b.id) ?? { busy: 0, count: 0 };
    return {
      berthId: b.id,
      berthName: instance.berthMeta.get(b.id)?.name ?? b.id,
      busyHours: round3(entry.busy),
      utilizationPct: makespan > 0 ? Math.round((entry.busy / makespan) * 1000) / 10 : 0,
      assignments: entry.count,
    };
  });

  const requestedLabel = SOLVER_LABELS[input.solver];
  const usedLabel = SOLVER_LABELS[outcome.solverUsed];
  const assumptions = [
    "SYNTHETIC demo data — not real port, ANP, or terminal data.",
    `Solver: ${usedLabel}${outcome.solverUsed !== input.solver ? ` (requested '${requestedLabel}')` : ""}.`,
    `Seed: ${input.seed} (deterministic — same input and seed reproduce this plan).`,
    "Handling time is derived from each vessel's ETA→ETD window; crane count is fixed at 2 per berth (synthetic).",
    `The exact solver proves optimality only on instances with ≤ ${EXACT_MAX_VESSELS} vessels; anything larger uses a heuristic and is never labelled optimal.`,
    "ALNS is not offered in this demo (superlinear runtime, unsuitable for interactive use).",
  ];

  return {
    solverRequested: input.solver,
    solverUsed: outcome.solverUsed,
    provenOptimal: outcome.provenOptimal,
    exactUnavailableReason: outcome.exactUnavailableReason,
    seed: input.seed,
    t0: instance.t0,
    vesselCount: input.vessels.length,
    assignments: kept,
    berthUtilization,
    unassigned,
    totalWaitingHours: round3(totalWaiting),
    makespanHours: round3(makespan),
    assumptions,
  };
}

/** Stable content hash: identical requests replay the identical record. */
export function computeInputHash(input: CreatePlanInput, instance: MappedInstance): string {
  const canonical = {
    scenarioName: input.scenarioName,
    solver: input.solver,
    seed: input.seed,
    idempotencyKey: input.idempotencyKey ?? null,
    vessels: instance.vessels
      .map((v) => ({
        id: v.id,
        name: v.name,
        lengthM: v.lengthM,
        draftM: v.draftM,
        etaHours: v.etaHours,
        handlingHours: v.handlingHours,
        cargo: v.cargo,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    berths: instance.berths
      .map((b) => ({
        id: b.id,
        name: b.name,
        lengthM: b.lengthM,
        grainCapable: b.grainCapable,
        cranes: b.cranes,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// ── Persistence ──────────────────────────────────────────────────────────

export interface BerthPlanRow {
  id: string;
  name: string;
  input_hash: string;
  solver: string;
  proven_optimal: number;
  result_json: string;
  assumptions: string;
  created_by: string;
  created_at: string;
}

const PLAN_COLUMNS =
  "id, name, input_hash, solver, proven_optimal, result_json, assumptions, created_by, created_at";

export function toBerthPlanDTO(row: BerthPlanRow): BerthPlanDTO {
  const payload = JSON.parse(row.result_json) as StoredPlanPayload;
  return {
    id: row.id,
    name: row.name,
    solverRequested: payload.solverRequested,
    solverUsed: payload.solverUsed,
    provenOptimal: payload.provenOptimal === true,
    exactUnavailableReason: payload.exactUnavailableReason,
    vesselCount: payload.vesselCount,
    assignments: payload.assignments,
    berthUtilization: payload.berthUtilization,
    unassigned: payload.unassigned,
    totalWaitingHours: payload.totalWaitingHours,
    makespanHours: payload.makespanHours,
    assumptions: payload.assumptions,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/**
 * Run the chosen solver and persist the plan run. Atomic idempotency: the
 * INSERT OR IGNORE inside a transaction makes the existence check and the
 * insert atomic — two concurrent identical requests can never create two
 * records. Returns { record, created }: created=false + the EXISTING record
 * on idempotent replay (caller should answer 200, not 201).
 *
 * The solver itself runs OUTSIDE the transaction (pure CPU, no DB) so the
 * write lock is held only for the insert.
 */
export function createPlanRun(
  db: DatabaseSync,
  userId: string,
  input: CreatePlanInput
): { record: BerthPlanDTO; created: boolean } {
  const instance = mapInputs(input);
  const outcome = solve(instance, input.solver, input.seed, input.vessels.length);
  const payload = buildPayload(input, instance, outcome);
  const inputHash = computeInputHash(input, instance);

  const { row, created } = withTransaction(
    db,
    (): { row: BerthPlanRow; created: boolean } => {
      const insert = db
        .prepare(
          `INSERT OR IGNORE INTO berth_plans
           (id, name, input_hash, solver, proven_optimal, result_json, assumptions, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          randomUUID(),
          input.scenarioName,
          inputHash,
          outcome.solverUsed,
          outcome.provenOptimal ? 1 : 0,
          JSON.stringify(payload),
          JSON.stringify(payload.assumptions),
          userId,
          new Date().toISOString()
        );
      const existing = db
        .prepare(
          `SELECT ${PLAN_COLUMNS} FROM berth_plans WHERE input_hash = ? AND solver = ?`
        )
        .get(inputHash, outcome.solverUsed) as unknown as BerthPlanRow | undefined;
      if (!existing) {
        // Fail closed: the row must exist after INSERT OR IGNORE.
        throw new Error("plan run insert failed without conflict");
      }
      return { row: existing, created: insert.changes === 1 };
    }
  );

  return { record: toBerthPlanDTO(row), created };
}

export function getPlanRun(db: DatabaseSync, id: string): BerthPlanDTO | null {
  const row = db
    .prepare(`SELECT ${PLAN_COLUMNS} FROM berth_plans WHERE id = ?`)
    .get(id) as unknown as BerthPlanRow | undefined;
  return row ? toBerthPlanDTO(row) : null;
}

export function listPlanRuns(db: DatabaseSync): BerthPlanDTO[] {
  const rows = db
    .prepare(`SELECT ${PLAN_COLUMNS} FROM berth_plans ORDER BY created_at DESC, rowid DESC`)
    .all() as unknown as BerthPlanRow[];
  return rows.map(toBerthPlanDTO);
}

// ── Demo scenario presets (SYNTHETIC — never inserted automatically) ─────
// (moved to ./planning-data.ts — client-safe for the "New plan" form)
