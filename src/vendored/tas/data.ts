/**
 * Seed / demo data for the Port of Casablanca truck-appointment demo.
 *
 * Everything here is deterministic given a seed and is safe to call on the
 * server or the client. Figures are fictional-but-plausible and are used for
 * illustration only.
 */

import type { BookingRequest, CargoType, GateId, MoveType } from './types';
import { DAY_END_MIN, DAY_START_MIN, SLOT_MINUTES } from './types';

/* ------------------------------------------------------------------ */
/* Companies                                                           */
/* ------------------------------------------------------------------ */

export const TRUCKING_COMPANIES: string[] = [
  'Atlas Freight Maroc',
  'Casa Logistics',
  'Maghreb Transport Express',
  'Saham Haulage',
  'Dakhla Road Cargo',
  'Rif Transports',
  'Chaabi Freight',
  'Souss Logistics',
  'Tanger Med Shuttle',
  'Oued Freight Co.',
  'Marrakech Cargo Line',
  'Fes Road Haulage',
];

/* ------------------------------------------------------------------ */
/* Terminals                                                           */
/* ------------------------------------------------------------------ */

export interface Terminal {
  id: string;
  name: string;
  gate: GateId;
}

export const TERMINALS: Terminal[] = [
  { id: 'T1', name: 'East Container Terminal', gate: 0 },
  { id: 'T2', name: 'Bulk & Grain Terminal', gate: 1 },
  { id: 'T3', name: 'Reefer Terminal', gate: 2 },
];

/** Lookup of terminal by gate id. */
export const TERMINAL_BY_GATE: Record<GateId, Terminal> = {
  0: TERMINALS[0],
  1: TERMINALS[1],
  2: TERMINALS[2],
};

/* ------------------------------------------------------------------ */
/* Cargo metadata                                                      */
/* ------------------------------------------------------------------ */

export interface CargoMeta {
  label: string;
  avgDwellHours: number;
  color: string;
}

export const CARGO_META: Record<CargoType, CargoMeta> = {
  general: { label: 'General Cargo', avgDwellHours: 48, color: '#3b82f6' },
  grain: { label: 'Grain & Bulk', avgDwellHours: 72, color: '#f59e0b' },
  reefer: { label: 'Reefer', avgDwellHours: 36, color: '#06b6d4' },
  hazmat: { label: 'Hazmat', avgDwellHours: 96, color: '#ef4444' },
};

export const CARGO_TYPES: CargoType[] = ['general', 'grain', 'reefer', 'hazmat'];
export const MOVE_TYPES: MoveType[] = ['import', 'export'];

/* ------------------------------------------------------------------ */
/* Benchmarks & facts                                                  */
/* ------------------------------------------------------------------ */

export const ENSEM_BENCHMARKS = {
  queueReductionPct: 62,
  reschedulePct: 7.8,
  co2SavedTonnesPerYear: 785,
  note:
    'Dynamic TAS modeled on real Casablanca port data (ENSEM Casablanca, as reported 2026).',
} as const;

export const PORT_FACTS = {
  tradeSharePct: 65,
  throughputBefore: 2800,
  throughputCrisis: 800,
  maxWaitHours: 12,
  gates: 3,
  sourceNote:
    'Crisis figures as reported in Moroccan press/social coverage, Oct 2026; demo uses simulated data.',
} as const;

/* ------------------------------------------------------------------ */
/* Deterministic PRNG                                                  */
/* ------------------------------------------------------------------ */

/**
 * mulberry32 — small, fast, deterministic 32-bit PRNG.
 * Returns a function producing floats in [0, 1).
 */
export function makeRng(seed: number): () => number {
  let a = (Number.isFinite(seed) ? Math.trunc(seed) : 0) >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Generators                                                          */
/* ------------------------------------------------------------------ */

/** Moroccan-style plate, e.g. "48213 - K - 6". */
export function randomPlate(rng: () => number): string {
  const digits = 10000 + Math.floor(rng() * 89999);
  const letter = String.fromCharCode(65 + Math.floor(rng() * 26));
  const region = 1 + Math.floor(rng() * 9);
  return `${digits} - ${letter} - ${region}`;
}

/** Weighted cargo pick: general .55, grain .20, reefer .15, hazmat .10. */
export function pickCargo(rng: () => number): CargoType {
  const r = rng();
  if (r < 0.55) return 'general';
  if (r < 0.75) return 'grain';
  if (r < 0.9) return 'reefer';
  return 'hazmat';
}

/** Import 60% / export 40%. */
export function pickMove(rng: () => number): MoveType {
  return rng() < 0.6 ? 'import' : 'export';
}

/** Morning rush 07:00-11:00, secondary 14:00-17:00, remainder spread. */
const MORNING_START = 420;
const MORNING_END = 660;
const AFTERNOON_START = 840;
const AFTERNOON_END = 1020;

function pickPreferredWindow(rng: () => number): { start: number; end: number } {
  const r = rng();
  let start: number;

  if (r < 0.6) {
    const slots = Math.max(1, Math.floor((MORNING_END - MORNING_START) / SLOT_MINUTES));
    start = MORNING_START + Math.floor(rng() * slots) * SLOT_MINUTES;
  } else if (r < 0.9) {
    const slots = Math.max(1, Math.floor((AFTERNOON_END - AFTERNOON_START) / SLOT_MINUTES));
    start = AFTERNOON_START + Math.floor(rng() * slots) * SLOT_MINUTES;
  } else {
    const span = DAY_END_MIN - DAY_START_MIN - 120;
    const slots = Math.max(1, Math.floor(span / SLOT_MINUTES));
    start = DAY_START_MIN + Math.floor(rng() * slots) * SLOT_MINUTES;
  }

  // Window length: 60, 90, 120, 150 or 180 minutes.
  const durationSlots = 2 + Math.floor(rng() * 5);
  let end = start + durationSlots * SLOT_MINUTES;
  if (end > DAY_END_MIN) end = DAY_END_MIN;
  if (end <= start) end = Math.min(start + SLOT_MINUTES, DAY_END_MIN);

  return { start, end };
}

/** Base epoch for the simulated operating day: 2026-10-12, 00:00 UTC. */
export const SIM_DAY_EPOCH_MS = Date.UTC(2026, 9, 12, 0, 0, 0, 0);

/**
 * Human label for a horizon day, e.g. "Mon 12 Oct".
 * Deterministic (UTC-based) so server and client agree.
 */
export function horizonDayLabel(day: number): string {
  const d = new Date(SIM_DAY_EPOCH_MS + day * 86_400_000);
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** ISO date (YYYY-MM-DD) for a horizon day — used by CSV export. */
export function horizonDayISO(day: number): string {
  return new Date(SIM_DAY_EPOCH_MS + day * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Generates `n` realistic booking requests for one operating day.
 * Deterministic for a given (n, seed) pair.
 */
export function generateDayRequests(n: number, seed: number): BookingRequest[] {
  const count = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  const rng = makeRng(seed);
  const requests: BookingRequest[] = [];

  for (let i = 0; i < count; i += 1) {
    const company = TRUCKING_COMPANIES[i % TRUCKING_COMPANIES.length];
    const cargo = pickCargo(rng);
    const move = pickMove(rng);
    const containers: 1 | 2 = rng() < 0.75 ? 1 : 2;
    const { start, end } = pickPreferredWindow(rng);

    // Lead time between 2 and 72 hours, rounded to the nearest half hour.
    const leadTimeHours = Math.round((2 + rng() * 70) * 2) / 2;

    // Historical no-show rate between 0 and 0.35.
    const driverNoShowRate = Math.round(rng() * 0.35 * 1000) / 1000;

    const preferredStartMs = SIM_DAY_EPOCH_MS + start * 60_000;
    const createdAt =
      preferredStartMs - leadTimeHours * 3_600_000 - Math.floor(rng() * 3_600_000);

    requests.push({
      id: `REQ-${String(i + 1).padStart(4, '0')}`,
      company,
      truckPlate: randomPlate(rng),
      cargo,
      move,
      containers,
      preferredStart: start,
      preferredEnd: end,
      leadTimeHours,
      driverNoShowRate,
      createdAt,
    });
  }

  return requests;
}

/**
 * Generates requests for a whole horizon: `days` days × `nPerDay` trucks.
 * Each day gets its own seed (seed + day * 101) so days differ but the
 * horizon is fully deterministic. Request ids are namespaced per day
 * (REQ-D1-0001) and each request carries its `day` offset.
 */
export function generateWeekRequests(
  nPerDay: number,
  seed: number,
  days: number = 7,
): BookingRequest[] {
  const out: BookingRequest[] = [];
  for (let day = 0; day < days; day += 1) {
    const dayReqs = generateDayRequests(nPerDay, seed + day * 101);
    for (const r of dayReqs) {
      out.push({
        ...r,
        id: `REQ-D${day + 1}-${r.id.replace('REQ-', '')}`,
        day,
      });
    }
  }
  return out;
}
