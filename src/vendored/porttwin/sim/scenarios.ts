/**
 * Scenario presets and default parameters for the Port of Casablanca twin.
 *
 * Calibrated so the three presets tell the crisis → recovery story:
 *  - "crisis": throughput collapses to gate capacity (~800 trucks/day),
 *    morning peak creates extreme queues and multi-hour waits.
 *  - "tas": appointment system + faster (pre-cleared) customs flattens
 *    arrivals; max queue drops sharply though demand still exceeds capacity.
 *  - "tas-night": TAS plus 24h gate operation and grain priority lifts
 *    throughput back toward pre-crisis levels (~2,700 TEU/day).
 *
 * These are stylized, not fitted to live port data — see README.
 */

import type { SimParams } from "./types";
import { cloneDisruptions, DEFAULT_DISRUPTIONS } from "./disruptions";

export const DEFAULT_PARAMS: SimParams = {
  seed: 42,
  simHours: 24,
  trucksPerDay: 1700,
  morningPeakFactor: 2.2,
  peakWindow: [6, 10],
  nightFactor: 0.25,

  appointmentSystem: false,
  appointmentShare: 0.85,
  noShowRate: 0.08,

  numGates: 3,
  gateOpenHour: 6,
  gateCloseHour: 22,
  gateServiceMeanMin: 3.6,
  gateServiceSigma: 0.5,

  yardCranes: 8,
  yardHandleMeanMin: 6,

  numBerths: 3,
  berthLoadMeanMin: 2.5,

  grainShare: 0.25,
  grainPriority: false,

  teuPerTruck: [1, 2],
  co2KgPerIdleHour: 2.68,

  disruptions: DEFAULT_DISRUPTIONS,
};

export interface Preset {
  id: string;
  name: string;
  tagline: string;
  /** Narrative shown in the guided demo. */
  story: string[];
  params: Partial<SimParams>;
}

export const PRESETS: Preset[] = [
  {
    id: "crisis",
    name: "Status quo — crisis",
    tagline: "No appointment system · 3 gates · slow customs",
    story: [
      "October 2026: Casablanca handles 65% of Morocco's foreign trade, but landside throughput has collapsed from ~2,800 to ~800 containers a day.",
      "2,600 trucks a day converge on just 3 gates with no appointment system. The 6–10 AM surge creates a queue that never clears.",
      "Watch the gate queue (amber) explode and average waits climb past 10 hours. Every idle hour burns diesel — and demurrage.",
    ],
    params: {
      appointmentSystem: false,
      numGates: 3,
      gateCloseHour: 22,
      gateServiceMeanMin: 3.6,
      grainPriority: false,
    },
  },
  {
    id: "tas",
    name: "Rotterdam-style TAS",
    tagline: "Appointment system · pre-cleared customs",
    story: [
      "The fix the port authority meets about on Oct 15: a truck appointment system. 85% of trucks now hold evenly spread slots; customs pre-clearance cuts gate service time.",
      "The same 2,600 trucks arrive — but flattened across the day, served from a priority appointment lane.",
      "Compare the max queue against the crisis run: a Moroccan ENSEM study on real Casablanca data measured a 62% reduction in maximum queue length.",
    ],
    params: {
      appointmentSystem: true,
      appointmentShare: 0.85,
      noShowRate: 0.08,
      numGates: 3,
      gateCloseHour: 22,
      gateServiceMeanMin: 2.4,
      grainPriority: false,
    },
  },
  {
    id: "tas-night",
    name: "TAS + night gate",
    tagline: "24h gates · grain berthing priority",
    story: [
      "Full recovery playbook: the appointment system plus round-the-clock gate operation and priority handling for record grain imports.",
      "Gate capacity nearly triples versus the crisis baseline. Throughput climbs back toward the pre-crisis ~2,800 containers a day.",
      "This is the 'what-if' Rotterdam and Singapore test in their digital twins before spending a dirham on concrete.",
    ],
    params: {
      appointmentSystem: true,
      appointmentShare: 0.85,
      noShowRate: 0.08,
      numGates: 3,
      gateCloseHour: 24,
      gateServiceMeanMin: 2.4,
      grainPriority: true,
    },
  },
];

/** Metadata driving the sandbox control panel. */
export interface ParamMeta {
  key: keyof SimParams;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  group: "Demand" | "Appointment system" | "Gates" | "Yard & berth" | "Cargo";
  hint: string;
}

export const PARAM_META: ParamMeta[] = [
  { key: "trucksPerDay", label: "Truck demand", min: 800, max: 4000, step: 50, unit: "/day", group: "Demand", hint: "Attempted arrivals per day" },
  { key: "morningPeakFactor", label: "Morning peak", min: 1, max: 4, step: 0.1, unit: "×", group: "Demand", hint: "Arrival surge 6–10 AM" },
  { key: "nightFactor", label: "Night arrivals", min: 0, max: 1, step: 0.05, unit: "×", group: "Demand", hint: "Arrival rate 0–5 AM vs daytime" },
  { key: "appointmentSystem", label: "Appointment system", min: 0, max: 1, step: 1, unit: "", group: "Appointment system", hint: "TAS on/off" },
  { key: "appointmentShare", label: "Appointment share", min: 0, max: 1, step: 0.05, unit: "%", group: "Appointment system", hint: "Trucks holding a slot" },
  { key: "noShowRate", label: "No-show rate", min: 0, max: 0.3, step: 0.01, unit: "%", group: "Appointment system", hint: "Slots wasted by no-shows" },
  { key: "numGates", label: "Active gates", min: 1, max: 4, step: 1, unit: "", group: "Gates", hint: "Casablanca has 3 today" },
  { key: "gateOpenHour", label: "Gate opening", min: 0, max: 8, step: 1, unit: ":00", group: "Gates", hint: "First hour gates serve trucks" },
  { key: "gateCloseHour", label: "Gate closing", min: 18, max: 24, step: 1, unit: ":00", group: "Gates", hint: "24 = night gate open" },
  { key: "gateServiceMeanMin", label: "Gate service time", min: 1, max: 8, step: 0.1, unit: " min", group: "Gates", hint: "Customs speed per truck" },
  { key: "gateServiceSigma", label: "Gate service variability", min: 0.1, max: 1.2, step: 0.05, unit: "σ", group: "Gates", hint: "Spread of customs check times" },
  { key: "yardCranes", label: "Yard cranes", min: 2, max: 12, step: 1, unit: "", group: "Yard & berth", hint: "Parallel handling capacity" },
  { key: "yardHandleMeanMin", label: "Yard handling time", min: 2, max: 15, step: 0.5, unit: " min", group: "Yard & berth", hint: "Mean time per truck in the yard" },
  { key: "numBerths", label: "Berths", min: 1, max: 5, step: 1, unit: "", group: "Yard & berth", hint: "Loading berths" },
  { key: "berthLoadMeanMin", label: "Berth loading time", min: 1, max: 8, step: 0.5, unit: " min", group: "Yard & berth", hint: "Mean time per truck at berth" },
  { key: "grainShare", label: "Grain share", min: 0, max: 0.6, step: 0.05, unit: "%", group: "Cargo", hint: "Record grain imports" },
  { key: "grainPriority", label: "Grain priority", min: 0, max: 1, step: 1, unit: "", group: "Cargo", hint: "Grain jumps yard queue" },
];

export function presetParams(id: string): SimParams {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`Unknown preset: ${id}`);
  return {
    ...DEFAULT_PARAMS,
    ...preset.params,
    // Clone: presets must never share the mutable DEFAULT_DISRUPTIONS object.
    disruptions: cloneDisruptions(
      (preset.params as Partial<SimParams>).disruptions ?? DEFAULT_DISRUPTIONS
    ),
  };
}
