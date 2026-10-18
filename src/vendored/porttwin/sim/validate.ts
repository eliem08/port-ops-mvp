/**
 * Runtime validation for saved scenarios (storage.ts).
 *
 * A saved scenario is untrusted input: it comes from localStorage, which
 * the user (or another tab, or a stale schema version) can corrupt. The
 * engine assumes well-typed params — e.g. `teuPerTruck` must be a numeric
 * pair — so loading an incompatible payload without validation can push
 * NaNs through the KPI pipeline or degenerate the simulation. Every field
 * is checked here; `validateSimParams` returns a clean `SimParams` or
 * null (the loader drops invalid entries instead of crashing).
 *
 * Schema version: bump SCENARIO_SCHEMA_VERSION whenever a required field
 * is added/renamed. The loader accepts entries with no version (legacy)
 * or version <= current; entries from a NEWER schema are dropped — we
 * cannot know what their fields mean.
 */

import type { Disruptions } from "./disruptions";
import type { SimParams } from "./types";

/** Current saved-scenario schema version. */
export const SCENARIO_SCHEMA_VERSION = 1;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isInt(v: unknown): v is number {
  return isFiniteNumber(v) && Number.isInteger(v);
}

function numIn(v: unknown, lo: number, hi: number): v is number {
  return isFiniteNumber(v) && v >= lo && v <= hi;
}

function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function checkWindow(
  v: unknown
): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    isFiniteNumber(v[0]) &&
    isFiniteNumber(v[1])
  );
}

interface WindowCheck {
  ok: boolean;
  value: [number, number] | null;
}

function validWindow(
  v: unknown,
  lo: number,
  hi: number,
  allowEqual = false
): WindowCheck {
  if (!checkWindow(v)) return { ok: false, value: null };
  const [a, b] = v;
  if (a < lo || a > hi || b < lo || b > hi) return { ok: false, value: null };
  if (allowEqual ? a > b : a >= b) return { ok: false, value: null };
  return { ok: true, value: [a, b] };
}

interface WindowFields {
  enabled: boolean;
  startHour: number;
  durationHours: number;
}

function validateDisruptionWindow(
  v: unknown,
  startKey = "startHour",
  durationKey = "durationHours"
): WindowFields | null {
  if (!isRecord(v)) return null;
  if (!isBool(v.enabled)) return null;
  if (!numIn(v[startKey], 0, 48)) return null;
  if (!numIn(v[durationKey], 0, 48)) return null;
  return {
    enabled: v.enabled,
    startHour: v[startKey] as number,
    durationHours: v[durationKey] as number,
  };
}

/** Validate a disruptions bundle; null on any incompatibility. */
export function validateDisruptions(input: unknown): Disruptions | null {
  if (!isRecord(input)) return null;
  const crane = validateDisruptionWindow(input.craneBreakdown);
  // Vessel bunching names its window fields differently
  // (windowStartHour / windowHours).
  const bunchWindow = validateDisruptionWindow(
    input.vesselBunching,
    "windowStartHour",
    "windowHours"
  );
  const gate = validateDisruptionWindow(input.gateClosure);
  const weather = validateDisruptionWindow(input.weatherSlowdown);
  if (!crane || !bunchWindow || !gate || !weather) return null;
  if (!isInt((input.craneBreakdown as Record<string, unknown>).craneIndex)) return null;
  if (
    !numIn(
      (input.vesselBunching as Record<string, unknown>).extraTrucks,
      0,
      100000
    )
  )
    return null;
  if (!isInt((input.gateClosure as Record<string, unknown>).gateIndex)) return null;
  if (
    !numIn(
      (input.weatherSlowdown as Record<string, unknown>).productivityFactor,
      0.01,
      1
    )
  )
    return null;
  return {
    craneBreakdown: {
      ...crane,
      craneIndex: (input.craneBreakdown as Record<string, unknown>)
        .craneIndex as number,
    },
    vesselBunching: {
      enabled: bunchWindow.enabled,
      extraTrucks: (input.vesselBunching as Record<string, unknown>)
        .extraTrucks as number,
      windowStartHour: bunchWindow.startHour,
      windowHours: bunchWindow.durationHours,
    },
    gateClosure: {
      ...gate,
      gateIndex: (input.gateClosure as Record<string, unknown>).gateIndex as number,
    },
    weatherSlowdown: {
      ...weather,
      productivityFactor: (input.weatherSlowdown as Record<string, unknown>)
        .productivityFactor as number,
    },
  };
}

/**
 * Validate a full SimParams object. Returns the params (typed) or null.
 * Bounds are permissive physics/sanity bounds, NOT the tighter UI slider
 * bounds — a scenario saved from the sandbox is always inside the UI
 * bounds, but validation must not reject values a future UI might allow.
 */
export function validateSimParams(input: unknown): SimParams | null {
  if (!isRecord(input)) return null;
  const p = input;

  if (!isFiniteNumber(p.seed)) return null;
  if (!numIn(p.simHours, 0.25, 24 * 30)) return null;
  if (!numIn(p.trucksPerDay, 0, 1e6)) return null;
  if (!numIn(p.morningPeakFactor, 0, 100)) return null;
  const peak = validWindow(p.peakWindow, 0, 24);
  if (!peak.ok || !peak.value) return null;
  if (!numIn(p.nightFactor, 0, 100)) return null;

  if (!isBool(p.appointmentSystem)) return null;
  if (!numIn(p.appointmentShare, 0, 1)) return null;
  if (!numIn(p.noShowRate, 0, 1)) return null;

  if (!isInt(p.numGates) || p.numGates < 0 || p.numGates > 20) return null;
  if (!numIn(p.gateOpenHour, 0, 24)) return null;
  if (!numIn(p.gateCloseHour, 0, 24)) return null;
  // gateCloseHour < gateOpenHour would mean "never open" (24 = open 24h).
  if (
    !(p.gateCloseHour as number >= 24) &&
    (p.gateCloseHour as number) < (p.gateOpenHour as number)
  )
    return null;
  if (!numIn(p.gateServiceMeanMin, 0.01, 120)) return null;
  if (!numIn(p.gateServiceSigma, 0.01, 5)) return null;

  if (!isInt(p.yardCranes) || p.yardCranes < 0 || p.yardCranes > 50) return null;
  if (!numIn(p.yardHandleMeanMin, 0.01, 120)) return null;

  if (!isInt(p.numBerths) || p.numBerths < 0 || p.numBerths > 20) return null;
  if (!numIn(p.berthLoadMeanMin, 0.01, 120)) return null;

  if (!numIn(p.grainShare, 0, 1)) return null;
  if (!isBool(p.grainPriority)) return null;

  const teu = validWindow(p.teuPerTruck, 0, 1000, true);
  if (!teu.ok || !teu.value) return null;
  if (!Number.isInteger(teu.value[0]) || !Number.isInteger(teu.value[1]))
    return null;
  if (!numIn(p.co2KgPerIdleHour, 0, 1000)) return null;

  const disruptions = validateDisruptions(p.disruptions);
  if (!disruptions) return null;

  return {
    seed: p.seed as number,
    simHours: p.simHours as number,
    trucksPerDay: p.trucksPerDay as number,
    morningPeakFactor: p.morningPeakFactor as number,
    peakWindow: peak.value,
    nightFactor: p.nightFactor as number,
    appointmentSystem: p.appointmentSystem as boolean,
    appointmentShare: p.appointmentShare as number,
    noShowRate: p.noShowRate as number,
    numGates: p.numGates as number,
    gateOpenHour: p.gateOpenHour as number,
    gateCloseHour: p.gateCloseHour as number,
    gateServiceMeanMin: p.gateServiceMeanMin as number,
    gateServiceSigma: p.gateServiceSigma as number,
    yardCranes: p.yardCranes as number,
    yardHandleMeanMin: p.yardHandleMeanMin as number,
    numBerths: p.numBerths as number,
    berthLoadMeanMin: p.berthLoadMeanMin as number,
    grainShare: p.grainShare as number,
    grainPriority: p.grainPriority as boolean,
    teuPerTruck: teu.value,
    co2KgPerIdleHour: p.co2KgPerIdleHour as number,
    disruptions,
  };
}

/**
 * Validate one stored scenario entry (name + version + params +
 * disruptions). Accepts legacy entries with no version field; drops
 * entries from a newer schema version. Returns the validated entry or
 * null.
 */
export function validateScenarioEntry(input: unknown): {
  name: string;
  savedAt: string;
  version: number;
  params: SimParams;
  disruptions: Disruptions;
} | null {
  if (!isRecord(input)) return null;
  if (typeof input.name !== "string" || input.name.trim().length === 0)
    return null;
  if (typeof input.savedAt !== "string") return null;
  const version =
    input.version === undefined ? 1 : (input.version as unknown);
  if (!isInt(version) || (version as number) < 1) return null;
  if ((version as number) > SCENARIO_SCHEMA_VERSION) return null; // newer schema: cannot interpret
  const params = validateSimParams(input.params);
  if (!params) return null;
  // The entry also carries a top-level disruptions bundle (kept for
  // backward compatibility); validate it independently.
  const disruptions = validateDisruptions(input.disruptions);
  if (!disruptions) return null;
  return {
    name: (input.name as string).trim(),
    savedAt: input.savedAt as string,
    version: version as number,
    params,
    disruptions,
  };
}
