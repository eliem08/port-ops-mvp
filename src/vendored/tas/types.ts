/**
 * Core domain types and constants for the Port of Casablanca
 * truck-appointment (TAS) simulation.
 *
 * All times are expressed in "minutes since midnight" unless the field
 * name explicitly says otherwise (e.g. `createdAt` is an epoch ms value).
 */

export type GateId = 0 | 1 | 2;

export type CargoType = 'general' | 'grain' | 'reefer' | 'hazmat';

export type MoveType = 'import' | 'export';

/** Terminal identifiers (see TERMINALS in data.ts). */
export type TerminalId = 'T1' | 'T2' | 'T3';

/** Number of days in the rolling planning horizon (7). */
export const HORIZON_DAYS = 7;

/** A trucking company's request for a gate slot. */
export interface BookingRequest {
  id: string;
  company: string;
  truckPlate: string;
  cargo: CargoType;
  move: MoveType;
  /** Number of containers carried by the truck: 1 or 2. */
  containers: 1 | 2;
  /** Preferred window start, minutes since midnight. */
  preferredStart: number;
  /** Preferred window end, minutes since midnight. */
  preferredEnd: number;
  /** How far in advance the booking was made, in hours. */
  leadTimeHours: number;
  /** Historical probability that this driver does not show up: 0..1. */
  driverNoShowRate: number;
  /** Epoch milliseconds at which the request was created. */
  createdAt: number;
  /**
   * Day offset inside the 7-day rolling horizon (0 = first day).
   * Defaults to 0 when omitted — single-day callers never need to set it.
   */
  day?: number;
  /**
   * Preferred terminal (T1/T2/T3). The optimizer prefers that terminal's
   * gate but may place the truck elsewhere when the gate is full.
   * Omitted (or 'any') means no terminal preference.
   */
  terminal?: TerminalId | 'any';
}

/** The scheduler's decision for a single request. */
export interface SlotAssignment {
  requestId: string;
  gate: GateId;
  /** Assigned slot start, minutes since midnight. */
  slotStart: number;
  /** True when the assignment falls outside the preferred window. */
  rescheduled: boolean;
  /** Modeled probability the truck does not arrive: 0..1. */
  noShowProbability: number;
  /** Modeled queue wait for this truck, in minutes. */
  waitEstimateMin: number;
  /** Day offset inside the 7-day rolling horizon (0 = first day). */
  day: number;
  /** Terminal the assignment serves (derived from the gate). */
  terminal: TerminalId;
}

/** Aggregated KPIs for one simulated day. */
export interface DayMetrics {
  maxQueueLength: number;
  avgWaitMin: number;
  totalTrucks: number;
  servedTrucks: number;
  /** Fraction of assignments that had to be moved: 0..1. */
  rescheduleRate: number;
  /** Per-gate utilization: 0..1 for gates 0, 1 and 2. */
  gateUtilization: [number, number, number];
  co2Tonnes: number;
  throughputPerHour: number;
  /** Queue length over the day, baseline vs optimized, `t` is "HH:MM". */
  queueSeries: Array<{ t: string; baseline: number; optimized: number }>;
  /** Day offset inside the horizon (0 = first day). Present on week runs. */
  day?: number;
  /** Optimizer method that produced the optimized metrics (week runs). */
  method?: OptimizerMethod;
}

/** Optimizer strategies the system can run on identical demand. */
export type OptimizerMethod = 'greedy' | 'annealed';

/** Full result of a baseline-vs-optimized scenario run. */
export interface ScenarioResult {
  baseline: DayMetrics;
  optimized: DayMetrics;
  params: { trucks: number; seed: number };
}

/** Aggregated KPIs across a multi-day horizon. */
export interface HorizonSummary {
  days: number;
  totalTrucks: number;
  totalCo2Baseline: number;
  totalCo2Optimized: number;
  co2SavedTonnes: number;
  avgWaitBaseline: number;
  avgWaitOptimized: number;
  maxQueueBaseline: number;
  maxQueueOptimized: number;
  rescheduleRate: number;
}

/** Multi-day simulation result: one ScenarioResult per day + totals. */
export interface WeekResult {
  days: ScenarioResult[];
  horizon: HorizonSummary;
}

/** One day of a horizon plan: its requests and their assignments. */
export interface HorizonDayPlan {
  day: number;
  requests: BookingRequest[];
  assignments: SlotAssignment[];
}

/** A full horizon plan: one optimized day-plan per day. */
export interface HorizonPlan {
  days: HorizonDayPlan[];
  method: OptimizerMethod;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Number of physical gates at the terminal. */
export const GATES = 3;

/** Length of one appointment slot, in minutes. */
export const SLOT_MINUTES = 30;

/** Operating day start: 06:00. */
export const DAY_START_MIN = 360;

/** Operating day end: 22:00. */
export const DAY_END_MIN = 1320;

/* ------------------------------------------------------------------ */
/* Per-gate service model                                             */
/* ------------------------------------------------------------------ */

/**
 * Per-gate service profile. Gates are NOT interchangeable: the express lane
 * checks a truck in ~4 minutes, the standard lane in ~5, and the inspection
 * lane (grain bulk + document checks) in ~8. Capacity per 30-minute slot is
 * floor(30 / service minutes), so faster gates hold more trucks per slot.
 */
export interface GateProfile {
  id: GateId;
  name: string;
  lane: 'express' | 'standard' | 'inspection';
  /** Minutes to process one truck at this gate. */
  serviceMin: number;
  /** Trucks this gate can take per 30-minute slot. */
  capacityPerSlot: number;
  /** Terminal served by this gate. */
  terminal: TerminalId;
  terminalName: string;
}

export const GATE_PROFILES: Record<GateId, GateProfile> = {
  0: {
    id: 0,
    name: 'Gate 1 · Express',
    lane: 'express',
    serviceMin: 4,
    capacityPerSlot: 7,
    terminal: 'T1',
    terminalName: 'East Container Terminal',
  },
  1: {
    id: 1,
    name: 'Gate 2 · Standard',
    lane: 'standard',
    serviceMin: 5,
    capacityPerSlot: 6,
    terminal: 'T2',
    terminalName: 'Bulk & Grain Terminal',
  },
  2: {
    id: 2,
    name: 'Gate 3 · Inspection',
    lane: 'inspection',
    serviceMin: 8,
    capacityPerSlot: 3,
    terminal: 'T3',
    terminalName: 'Reefer Terminal',
  },
};

/** Trucks a gate can take per 30-minute slot (per-gate service model). */
export function capacityForGate(gate: GateId): number {
  return GATE_PROFILES[gate].capacityPerSlot;
}

/** Service time (minutes per truck) for a gate. */
export function serviceMinForGate(gate: GateId): number {
  return GATE_PROFILES[gate].serviceMin;
}

/** Terminal served by a gate. */
export function terminalForGate(gate: GateId): TerminalId {
  return GATE_PROFILES[gate].terminal;
}

/** Gate serving a terminal. */
export function gateForTerminal(terminal: TerminalId): GateId {
  return GATE_PROFILES[0].terminal === terminal
    ? 0
    : GATE_PROFILES[1].terminal === terminal
      ? 1
      : 2;
}

/** Average gate service time per truck, in minutes (standard lane). */
export const SERVICE_MIN_PER_TRUCK = 5;

/** Idle fuel burn of a waiting truck, litres per hour. */
export const IDLE_FUEL_L_PER_H = 2.5;

/** Kilograms of CO2 emitted per litre of diesel burned. */
export const CO2_KG_PER_L = 2.68;

/* ------------------------------------------------------------------ */
/* Derived values                                                      */
/* ------------------------------------------------------------------ */

/** Total minutes in the operating day (960). */
export const DAY_LENGTH_MIN = DAY_END_MIN - DAY_START_MIN;

/** Number of 30-minute slots per gate per day (32). */
export const SLOTS_PER_GATE = Math.floor(DAY_LENGTH_MIN / SLOT_MINUTES);

/** Total appointment capacity across all gates for one day (96). */
export const TOTAL_SLOTS_PER_DAY = SLOTS_PER_GATE * GATES;

/** Stable list of gate ids, useful for iteration. */
export const GATE_IDS: readonly GateId[] = [0, 1, 2];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Formats minutes-since-midnight as a zero-padded "HH:MM" string. */
export function minutesToHHMM(min: number): string {
  const safe = Number.isFinite(min) ? Math.round(min) : 0;
  const wrapped = ((safe % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Converts a slot index (0..SLOTS_PER_GATE-1) to its start minute. */
export function slotIndexToStart(index: number): number {
  return DAY_START_MIN + index * SLOT_MINUTES;
}

/** Converts a start minute to the nearest slot index, clamped to the day. */
export function startToSlotIndex(start: number): number {
  return clampSlotIndex(Math.floor((start - DAY_START_MIN) / SLOT_MINUTES));
}

/** Converts a minute to the first slot index starting at or after it. */
export function slotIndexAtOrAfter(min: number): number {
  if (!Number.isFinite(min)) return 0;
  return clampSlotIndex(Math.ceil((min - DAY_START_MIN) / SLOT_MINUTES));
}

/** Clamps a slot index into the valid range for the operating day. */
export function clampSlotIndex(index: number): number {
  if (!Number.isFinite(index)) return 0;
  const i = Math.trunc(index);
  if (i < 0) return 0;
  if (i > SLOTS_PER_GATE - 1) return SLOTS_PER_GATE - 1;
  return i;
}

/** Type guard for gate identifiers. */
export function isGateId(value: number): value is GateId {
  return value === 0 || value === 1 || value === 2;
}

/** CO2 (tonnes) produced by `trucks` idling for `minutes` each. */
export function idleCo2Tonnes(trucks: number, minutes: number): number {
  const litres = (trucks * minutes * IDLE_FUEL_L_PER_H) / 60;
  return (litres * CO2_KG_PER_L) / 1000;
}

/** Fraction of the operating day covered by a slot, used for utilization. */
export const SLOT_HOURS = SLOT_MINUTES / 60;
