// PortTwin simulation domain logic — shared by the API routes (and directly testable).
// DB rows are snake_case; the DTOs here are camelCase contract shapes.
//
// Runs go through the vendored PortTwin engine (src/vendored/porttwin/sim —
// READ-ONLY): runScenario validates, runs the Monte Carlo replications and
// returns the contracted output. This module persists results to the
// simulation_runs SQLite table instead of the engine's in-memory demo caches.
//
// MODEL STATUS: UNCALIBRATED — every surface must carry UNCALIBRATED_NOTICE.
// KPI figures are provenance-labeled "simulated"; scenario parameters "assumed";
// nothing is ever labeled "measured".

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  PRESETS,
  presetParams,
  type Preset,
} from "@/vendored/porttwin/sim/scenarios";
import {
  SIM_INPUT_CONTRACT_VERSION,
  inputHash,
  loadSimulationInput,
  type SimulationInput,
  type SimulationOutput,
} from "@/vendored/porttwin/sim/contracts";
import { runScenario } from "@/vendored/porttwin/sim/service";
import { toPublicError } from "@/vendored/porttwin/sim/errors";
import {
  CreateSimulationInput,
  type SimulationParamOverrides,
} from "@/contracts";
import { withTransaction } from "./route-helpers";

/** Canonical notice: the model has NOT been calibrated against real port data. */
export const UNCALIBRATED_NOTICE =
  "Model uncalibrated against real operational data — outputs are illustrative, not predictions.";

/* ------------------------------------------------------------------ */
/* Demo scenario presets (from the vendored definitions, synthetic).   */
/* ------------------------------------------------------------------ */

export interface DemoSimulationScenario {
  id: string;
  name: string;
  description: string;
  synthetic: true;
}

export const DEMO_SIMULATION_SCENARIOS: DemoSimulationScenario[] = PRESETS.map(
  (p) => ({
    id: p.id,
    name: p.name,
    description: `${p.tagline}. ${p.story[0] ?? ""}`.trim(),
    synthetic: true as const,
  })
);

/* ------------------------------------------------------------------ */
/* DTOs                                                                */
/* ------------------------------------------------------------------ */

export type FigureProvenance = "simulated" | "assumed";

export interface KpiFigure {
  key: string;
  label: string;
  value: number | string;
  unit: string;
  /** KPI outputs are "simulated"; scenario parameters are "assumed". Never "measured". */
  provenance: FigureProvenance;
}

export interface SimulationRunDTO {
  id: string;
  scenarioName: string;
  scenarioId: string;
  seed: number;
  replications: number;
  inputHash: string;
  status: "completed";
  kpis: KpiFigure[];
  parameters: KpiFigure[];
  assumptions: string[];
  warnings: string[];
  /** Always false: the model is uncalibrated (no real operational data yet). */
  calibrated: false;
  createdBy: string;
  createdAt: string;
}

export interface KpiDelta {
  key: string;
  label: string;
  unit: string;
  a: number | string;
  b: number | string;
  /** b − a for numeric KPIs; null for non-numeric figures. */
  delta: number | null;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** 400-class failure: carries the vendored public error message. */
export class SimulationValidationError extends Error {
  readonly status = 400;
  readonly publicError: { code: string; message: string; details?: unknown };
  constructor(publicError: {
    code: string;
    message: string;
    details?: unknown;
  }) {
    super(publicError.message);
    this.name = "SimulationValidationError";
    this.publicError = publicError;
  }
}

/** 404-class failure: unknown simulation run id. */
export class SimulationNotFoundError extends Error {
  readonly status = 404;
  constructor(id: string) {
    super(`Simulation run not found: ${id}`);
    this.name = "SimulationNotFoundError";
  }
}

function toSimulationValidationError(err: unknown): SimulationValidationError {
  const pub = toPublicError(err, (e) =>
    console.error("[simulation] internal error:", e)
  );
  return new SimulationValidationError({
    code: pub.code,
    message: pub.message,
    details: pub.details,
  });
}

/* ------------------------------------------------------------------ */
/* Vendored input construction                                         */
/* ------------------------------------------------------------------ */

/**
 * Build the validated vendored SimulationInput for a preset + overrides.
 * Throws SimulationValidationError on unknown scenarioId or contract
 * validation failure. The vendored contract drops engine parameters it
 * has no field for (e.g. gate operating hours) — those fall back to
 * illustrative engine defaults; see the DTO warnings/assumptions.
 */
export function buildSimulationInput(
  scenarioId: string,
  seed: number,
  replications: number,
  overrides: SimulationParamOverrides = {}
): SimulationInput {
  let params;
  try {
    params = presetParams(scenarioId);
  } catch {
    throw new SimulationValidationError({
      code: "VALIDATION_ERROR",
      message: `Unknown scenarioId '${scenarioId}'. Must be one of: ${PRESETS.map((p) => p.id).join(", ")}.`,
    });
  }

  // Small allowlist of numeric overrides applied on top of the preset.
  if (overrides.horizonHours !== undefined) params.simHours = overrides.horizonHours;
  if (overrides.trucksPerDay !== undefined) params.trucksPerDay = overrides.trucksPerDay;
  if (overrides.numGates !== undefined) params.numGates = overrides.numGates;
  if (overrides.gateServiceMeanMin !== undefined)
    params.gateServiceMeanMin = overrides.gateServiceMeanMin;

  // Validate-first through the vendored contract (version gate + schema).
  return loadSimulationInput({
    contractVersion: SIM_INPUT_CONTRACT_VERSION,
    scenarioId,
    seed,
    replications,
    horizonHours: params.simHours,
    resources: [
      { id: "gate-lanes", kind: "gate-lane", count: params.numGates, unit: "lanes" },
      { id: "yard-cranes", kind: "yard-crane", count: params.yardCranes, unit: "cranes" },
      { id: "berths", kind: "berth", count: params.numBerths, unit: "berths" },
    ],
    arrivalProcess: {
      type: params.appointmentSystem ? "scheduled" : "poisson",
      ratePerHour: params.trucksPerDay / 24,
      peakFactor: params.morningPeakFactor,
      peakWindowStartHour: params.peakWindow[0],
      peakWindowEndHour: params.peakWindow[1],
      appointmentSharePct: params.appointmentShare * 100,
      unit: "trucks/hour",
    },
    serviceTimeDistributions: {
      gateServiceMin: {
        family: "lognormal",
        meanMin: params.gateServiceMeanMin,
        sigma: params.gateServiceSigma,
        unit: "minutes",
      },
      yardHandlingMin: {
        family: "lognormal",
        meanMin: params.yardHandleMeanMin,
        sigma: 0.4,
        unit: "minutes",
      },
      berthLoadingMin: {
        family: "exponential",
        meanMin: params.berthLoadMeanMin,
        unit: "minutes",
      },
    },
    costAssumptions: [],
    grainSharePct: params.grainShare * 100,
    grainPriority: params.grainPriority,
  });
}

/** Engine parameters actually simulated, for the "assumed" provenance table. */
export function appliedSimParams(scenarioId: string, overrides: SimulationParamOverrides = {}) {
  const params = presetParams(scenarioId);
  if (overrides.horizonHours !== undefined) params.simHours = overrides.horizonHours;
  if (overrides.trucksPerDay !== undefined) params.trucksPerDay = overrides.trucksPerDay;
  if (overrides.numGates !== undefined) params.numGates = overrides.numGates;
  if (overrides.gateServiceMeanMin !== undefined)
    params.gateServiceMeanMin = overrides.gateServiceMeanMin;
  return params;
}

/* ------------------------------------------------------------------ */
/* DTO assembly                                                        */
/* ------------------------------------------------------------------ */

interface SimulationRunRow {
  id: string;
  scenario_name: string;
  input_hash: string;
  seed: number;
  result_json: string;
  assumptions: string;
  calibrated: number;
  created_by: string;
  created_at: string;
}

/**
 * Persisted payload: the vendored contract output plus the engine
 * parameters actually simulated. The output's completedAtUtc is set to
 * the row's created_at so identical logical inputs persist byte-identical
 * result_json (reproducibility).
 */
interface PersistedSimulationResult {
  output: SimulationOutput;
  appliedParams: Record<string, number | boolean>;
}

const SIM_RUN_COLUMNS =
  "id, scenario_name, input_hash, seed, result_json, assumptions, calibrated, created_by, created_at";

function parsePersisted(row: SimulationRunRow): PersistedSimulationResult {
  return JSON.parse(row.result_json) as PersistedSimulationResult;
}

function kpiFigures(output: SimulationOutput): KpiFigure[] {
  const k = output.kpis;
  const fig = (
    key: string,
    label: string,
    value: number,
    unit: string
  ): KpiFigure => ({ key, label, value, unit, provenance: "simulated" });
  return [
    fig("throughputTrucksPerHour", "Throughput", k.throughputTrucksPerHour, "trucks/hour"),
    fig("throughputTeuPerHour", "TEU throughput", k.throughputTeuPerHour, "TEU/hour"),
    fig("meanWaitMin", "Mean gate wait", k.meanWaitMin, "min"),
    fig("p95WaitMin", "P95 gate wait", k.p95WaitMin, "min"),
    fig("maxQueueMean", "Mean max gate queue", k.maxQueueMean, "trucks"),
    fig("utilizationGatePct", "Gate utilization", k.utilizationPct.gate, "%"),
    fig("utilizationYardPct", "Yard utilization", k.utilizationPct.yard, "%"),
    fig("utilizationBerthPct", "Berth utilization", k.utilizationPct.berth, "%"),
    fig("co2Tonnes", "CO₂ from idle queue", k.co2Tonnes, "t"),
    fig("completedTrucksMean", "Trucks completed", k.completedTrucksMean, "trucks"),
  ];
}

const PARAM_LABELS: Record<string, { label: string; unit: string; pct?: boolean }> = {
  simHours: { label: "Simulated horizon", unit: "hours" },
  trucksPerDay: { label: "Truck demand", unit: "trucks/day" },
  morningPeakFactor: { label: "Morning peak factor", unit: "×" },
  nightFactor: { label: "Night arrival factor", unit: "×" },
  appointmentShare: { label: "Appointment share", unit: "%", pct: true },
  noShowRate: { label: "No-show rate", unit: "%", pct: true },
  numGates: { label: "Active gates", unit: "lanes" },
  gateOpenHour: { label: "Gate opening", unit: ":00" },
  gateCloseHour: { label: "Gate closing", unit: ":00" },
  gateServiceMeanMin: { label: "Mean gate service", unit: "min" },
  yardCranes: { label: "Yard cranes", unit: "cranes" },
  yardHandleMeanMin: { label: "Mean yard handling", unit: "min" },
  numBerths: { label: "Berths", unit: "berths" },
  berthLoadMeanMin: { label: "Mean berth loading", unit: "min" },
  grainShare: { label: "Grain share", unit: "%", pct: true },
};

function parameterFigures(appliedParams: Record<string, number | boolean>): KpiFigure[] {
  const figs: KpiFigure[] = [];
  for (const [key, meta] of Object.entries(PARAM_LABELS)) {
    const v = appliedParams[key];
    if (typeof v !== "number") continue;
    figs.push({
      key,
      label: meta.label,
      value: meta.pct ? v * 100 : v,
      unit: meta.unit,
      provenance: "assumed",
    });
  }
  const bool = (key: string, label: string) => {
    const v = appliedParams[key];
    if (typeof v !== "boolean") return;
    figs.push({ key, label, value: v ? "on" : "off", unit: "", provenance: "assumed" });
  };
  bool("appointmentSystem", "Appointment system");
  bool("grainPriority", "Grain priority");
  return figs;
}

function buildAssumptions(preset: Preset, output: SimulationOutput): string[] {
  return [
    "SYNTHETIC demo data",
    "UNCALIBRATED model",
    UNCALIBRATED_NOTICE,
    `Scenario: ${preset.name} — ${preset.tagline}`,
    "Scenario preset parameters without a contract equivalent (e.g. gate operating hours) use illustrative engine defaults, not the preset's values.",
    ...output.assumptions.map((a) => a.statement),
  ];
}

export function toSimulationRunDTO(row: SimulationRunRow): SimulationRunDTO {
  const persisted = parsePersisted(row);
  // Seed data uses a simplified format without the `output` wrapper.
  // Handle both: engine output (with `output`) and seed format (flat).
  const output = persisted.output ?? (persisted as unknown as SimulationOutput);
  const replications = output.confidenceIntervals?.[0]?.replications ?? 0;
  // Seed KPIs use snake_case; engine KPIs use camelCase. Normalize for the DTO.
  const kpis = output.kpis as unknown as Record<string, any>;
  const utilPct = kpis.utilizationPct as { gate?: number; yard?: number; berth?: number } | undefined;
  const normalizedKpis = {
    throughputTrucksPerHour: kpis.throughputTrucksPerHour ?? kpis.gate_throughput_per_h ?? 0,
    throughputTeuPerHour: kpis.throughputTeuPerHour ?? 0,
    meanWaitMin: kpis.meanWaitMin ?? kpis.avg_truck_turnaround_min ?? 0,
    p95WaitMin: kpis.p95WaitMin ?? 0,
    maxQueueMean: kpis.maxQueueMean ?? kpis.max_gate_queue ?? 0,
    utilizationPct: {
      gate: utilPct?.gate ?? 0,
      yard: utilPct?.yard ?? 0,
      berth: utilPct?.berth ?? kpis.berth_utilization_pct ?? 0,
    },
    co2Tonnes: kpis.co2Tonnes ?? 0,
    completedTrucksMean: kpis.completedTrucksMean ?? 0,
  };
  return {
    id: row.id,
    scenarioName: row.scenario_name,
    scenarioId: output.scenarioId ?? "seed",
    seed: row.seed,
    replications,
    inputHash: row.input_hash,
    status: "completed",
    kpis: kpiFigures({ ...output, kpis: normalizedKpis } as SimulationOutput),
    parameters: parameterFigures(persisted.appliedParams ?? {}),
    assumptions: JSON.parse(row.assumptions) as string[],
    warnings: output.warnings ?? [],
    calibrated: false,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function getSimulationRow(db: DatabaseSync, inputHashValue: string): SimulationRunRow | null {
  const row = db
    .prepare(`SELECT ${SIM_RUN_COLUMNS} FROM simulation_runs WHERE input_hash = ?`)
    .get(inputHashValue) as unknown as SimulationRunRow | undefined;
  return row ?? null;
}

function getSimulationRowById(db: DatabaseSync, id: string): SimulationRunRow | null {
  const row = db
    .prepare(`SELECT ${SIM_RUN_COLUMNS} FROM simulation_runs WHERE id = ?`)
    .get(id) as unknown as SimulationRunRow | undefined;
  return row ?? null;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export function listSimulationRuns(db: DatabaseSync): SimulationRunDTO[] {
  const rows = db
    .prepare(`SELECT ${SIM_RUN_COLUMNS} FROM simulation_runs ORDER BY created_at DESC`)
    .all() as unknown as SimulationRunRow[];
  return rows.map(toSimulationRunDTO);
}

export function getSimulationRun(db: DatabaseSync, id: string): SimulationRunDTO | null {
  const row = getSimulationRowById(db, id);
  return row ? toSimulationRunDTO(row) : null;
}

/**
 * Compare two runs: both DTOs plus a per-KPI delta table (delta = B − A).
 * Throws SimulationNotFoundError for an unknown id.
 */
export function compareSimulationRuns(
  db: DatabaseSync,
  idA: string,
  idB: string
): { a: SimulationRunDTO; b: SimulationRunDTO; deltas: KpiDelta[] } {
  const a = getSimulationRun(db, idA);
  if (!a) throw new SimulationNotFoundError(idA);
  const b = getSimulationRun(db, idB);
  if (!b) throw new SimulationNotFoundError(idB);
  const deltas: KpiDelta[] = a.kpis.map((ka) => {
    const kb = b.kpis.find((k) => k.key === ka.key);
    const numeric = typeof ka.value === "number" && typeof kb?.value === "number";
    return {
      key: ka.key,
      label: ka.label,
      unit: ka.unit,
      a: ka.value,
      b: kb?.value ?? "—",
      delta: numeric ? (kb!.value as number) - (ka.value as number) : null,
    };
  });
  return { a, b, deltas };
}

/* ------------------------------------------------------------------ */
/* Create (atomic idempotency on input_hash)                           */
/* ------------------------------------------------------------------ */

/**
 * Run a scenario and persist it. The vendored runScenario validates first
 * and is deterministic for a fixed seed.
 *
 * Atomic idempotency: the INSERT OR IGNORE on the UNIQUE(input_hash)
 * column inside a transaction makes the check-and-insert atomic — two
 * concurrent requests with the same logical input can never create two
 * rows. Returns { record, created }: created=false + the EXISTING record
 * when the input hash was already seen (caller should answer 200, not 201).
 *
 * SimError from the engine is mapped to SimulationValidationError (400)
 * with the vendored public message.
 */
export function createSimulationRun(
  db: DatabaseSync,
  userId: string,
  input: CreateSimulationInput
): { record: SimulationRunDTO; created: boolean } {
  const preset = PRESETS.find((p) => p.id === input.scenarioId);
  if (!preset) {
    // Fail closed: the contract enum should already have rejected this.
    throw new SimulationValidationError({
      code: "VALIDATION_ERROR",
      message: `Unknown scenarioId '${input.scenarioId}'. Must be one of: ${PRESETS.map((p) => p.id).join(", ")}.`,
    });
  }

  let validated: SimulationInput;
  try {
    validated = buildSimulationInput(
      input.scenarioId,
      input.seed,
      input.replications,
      input.paramOverrides ?? {}
    );
  } catch (err) {
    if (err instanceof SimulationValidationError) throw err;
    throw toSimulationValidationError(err);
  }
  const hash = inputHash(validated);

  // Fast-path idempotent replay: this exact input already ran.
  const existing = getSimulationRow(db, hash);
  if (existing) return { record: toSimulationRunDTO(existing), created: false };

  // Synchronous run through the validated vendored service.
  let output: SimulationOutput;
  try {
    output = runScenario(validated, {
      idempotencyKey: input.idempotencyKey ?? hash,
      actor: userId,
    });
  } catch (err) {
    throw toSimulationValidationError(err);
  }

  const now = new Date().toISOString();
  // completedAtUtc := row created_at: identical logical inputs persist
  // byte-identical result_json (reproducibility).
  const persisted: PersistedSimulationResult = {
    output: { ...output, completedAtUtc: now },
    appliedParams: pickAppliedParams(input.scenarioId, input.paramOverrides ?? {}),
  };
  const resultJson = JSON.stringify(persisted);
  const assumptionsJson = JSON.stringify(buildAssumptions(preset, output));
  const id = randomUUID();

  const { row, created } = withTransaction(
    db,
    (): { row: SimulationRunRow; created: boolean } => {
      const claimed = db
        .prepare(
          `INSERT OR IGNORE INTO simulation_runs
           (id, scenario_name, input_hash, seed, result_json, assumptions, calibrated, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
        )
        .run(id, input.scenarioName, hash, input.seed, resultJson, assumptionsJson, userId, now);
      if (claimed.changes === 0) {
        // Lost the race: another request persisted this input first.
        const raced = getSimulationRow(db, hash);
        if (!raced) throw new Error("simulation run claimed but no record found");
        return { row: raced, created: false };
      }
      const inserted = getSimulationRowById(db, id);
      if (!inserted) throw new Error("simulation run inserted but not found");
      return { row: inserted, created: true };
    }
  );

  return { record: toSimulationRunDTO(row), created };
}

/** Numeric/boolean engine params actually simulated (for "assumed" provenance). */
function pickAppliedParams(
  scenarioId: string,
  overrides: SimulationParamOverrides
): Record<string, number | boolean> {
  const p = appliedSimParams(scenarioId, overrides);
  return {
    simHours: p.simHours,
    trucksPerDay: p.trucksPerDay,
    morningPeakFactor: p.morningPeakFactor,
    nightFactor: p.nightFactor,
    appointmentSystem: p.appointmentSystem,
    appointmentShare: p.appointmentShare,
    noShowRate: p.noShowRate,
    numGates: p.numGates,
    gateOpenHour: p.gateOpenHour,
    gateCloseHour: p.gateCloseHour,
    gateServiceMeanMin: p.gateServiceMeanMin,
    gateServiceSigma: p.gateServiceSigma,
    yardCranes: p.yardCranes,
    yardHandleMeanMin: p.yardHandleMeanMin,
    numBerths: p.numBerths,
    berthLoadMeanMin: p.berthLoadMeanMin,
    grainShare: p.grainShare,
    grainPriority: p.grainPriority,
  };
}
