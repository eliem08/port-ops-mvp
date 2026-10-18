/**
 * Shared types for the Port of Casablanca digital twin simulation.
 *
 * The model is a three-stage tandem queue representing landside operations:
 *
 *   arrivals ──▶ GATE (c = numGates servers) ──▶ YARD (c = yardCranes)
 *              ──▶ BERTH (c = numBerths) ──▶ completed
 *
 * Trucks queue at the gate when all gates are busy or gates are closed.
 * An optional truck-appointment system (TAS) flattens the arrival profile by
 * spreading appointment holders across evenly spaced slots; walk-ins keep a
 * peaky arrival profile and wait in a lower-priority lane.
 */

import type { Disruptions } from "./disruptions";

/** Tunable parameters of one simulation run. All times in minutes unless noted. */
export interface SimParams {
  /** Integer seed for the deterministic PRNG. */
  seed: number;
  /** Simulated horizon in hours (e.g. 24). */
  simHours: number;
  /** Attempted truck arrivals per 24 h (scaled to simHours). */
  trucksPerDay: number;
  /** Arrival-rate multiplier inside the morning peak window. */
  morningPeakFactor: number;
  /** [startHour, endHour] of the morning peak (24h clock). */
  peakWindow: [number, number];
  /** Arrival-rate multiplier during night hours (0–5h). */
  nightFactor: number;

  /** Master switch for the truck appointment system. */
  appointmentSystem: boolean;
  /** Share of trucks holding an appointment when TAS is on (0..1). */
  appointmentShare: number;
  /** Share of appointment holders that never show up (0..1). */
  noShowRate: number;

  /** Number of gate lanes (1..4). */
  numGates: number;
  /** Gate opening hour (24h clock). */
  gateOpenHour: number;
  /** Gate closing hour; 24 means gates never close. */
  gateCloseHour: number;
  /** Mean gate service time per truck (customs + checks). */
  gateServiceMeanMin: number;
  /** Lognormal shape parameter for gate service time. */
  gateServiceSigma: number;

  /** Number of yard cranes (parallel handling servers). */
  yardCranes: number;
  /** Mean yard handling time per truck. */
  yardHandleMeanMin: number;

  /** Number of berths (parallel loading servers). */
  numBerths: number;
  /** Mean berth loading time per truck. */
  berthLoadMeanMin: number;

  /** Share of trucks carrying grain (record grain imports). */
  grainShare: number;
  /** When true, grain trucks jump the yard queue. */
  grainPriority: boolean;

  /** TEU per truck, uniform integer in [min, max]. */
  teuPerTruck: [number, number];
  /** kg of CO2 emitted per hour a truck idles in the gate queue. */
  co2KgPerIdleHour: number;

  /**
   * Disruption bundle (crane breakdown, vessel bunching, gate closure,
   * weather slowdown). All off by default; see disruptions.ts.
   */
  disruptions: Disruptions;
}

/** A truck moving through the simulated port. */
export interface Truck {
  id: number;
  arrivalTime: number; // minutes since sim start
  hasAppointment: boolean;
  slotTime: number | null; // scheduled slot (min), if any
  teu: number;
  isGrain: boolean;
  gateStartTime: number | null;
  gateWaitMin: number;
}

/** State snapshot sampled on a fixed cadence for charts/animation. */
export interface Snapshot {
  /** Minutes since sim start. */
  t: number;
  /** Total trucks waiting at the gate (both lanes). */
  gateQueue: number;
  appointmentQueue: number;
  walkinQueue: number;
  gatesBusy: number;
  yardQueue: number;
  yardBusy: number;
  berthQueue: number;
  berthsBusy: number;
  completedTrucks: number;
  completedTeu: number;
}

/** Aggregate key performance indicators for one run. */
export interface Kpis {
  /** Containers (TEU) fully processed per 24 h. */
  throughputTeuPerDay: number;
  /** Trucks fully processed per 24 h. */
  throughputTrucksPerDay: number;
  /** Mean gate waiting time in minutes (served trucks). */
  avgWaitMin: number;
  /** Maximum observed gate queue length. */
  maxQueue: number;
  /** Mean fraction of gate open-server-minutes spent busy (average per-lane utilization, 0–1). */
  gateUtilization: number;
  yardUtilization: number;
  berthUtilization: number;
  /** Tonnes of CO2 from trucks idling in the gate queue. */
  co2Tonnes: number;
  /** Total truck arrivals generated. */
  totalTrucks: number;
  /** Trucks that completed all three stages. */
  completedTrucks: number;
  /** Mean end-to-end time (arrival → berth completion), minutes. */
  avgSystemMin: number;
  /** Total gate-wait truck-hours (served trucks), for cost modelling. */
  totalWaitHours: number;
  /** Total end-to-end truck-hours (completed trucks). */
  totalSystemHours: number;
  /** Total busy crane-hours at the yard. */
  yardCraneHours: number;
  /** Total busy crane-hours at the berths. */
  berthCraneHours: number;
}

/** Full result of one simulation run. */
export interface SimResult {
  params: SimParams;
  kpis: Kpis;
  /** Snapshots sampled every `snapshotEveryMin` (see engine). */
  series: Snapshot[];
  /**
   * Gate wait per served truck, in minutes. Used by the cost module to
   * price demurrage/detention beyond a free-time threshold.
   */
  waitSamplesMin: number[];
  /**
   * Raw counters for verification & validation (V&V): conservation of
   * flow, Little's Law, and utilization identities. Computed from the
   * run's own bookkeeping, independent of KPI aggregation.
   */
  verification: VerificationCounters;
}

/**
 * Bookkeeping counters used by the V&V module. All are exact counts or
 * sums from the event loop — no estimation involved.
 */
export interface VerificationCounters {
  /** Trucks generated (arrivals). */
  totalArrivals: number;
  /** Trucks that completed all three stages. */
  completed: number;
  /** Trucks still in the system (queue or service) at the horizon end. */
  inSystemEnd: number;
  /** Trucks that started gate service. */
  gateStarts: number;
  /** Trucks that started yard handling. */
  yardStarts: number;
  /** Trucks that started berth loading. */
  berthStarts: number;
  /** Sum of realized gate service times (minutes, across lanes). */
  gateBusyMin: number;
  /** Sum of realized yard handling times (minutes, across cranes). */
  yardBusyMin: number;
  /** Sum of realized berth loading times (minutes, across berths). */
  berthBusyMin: number;
  /**
   * Time-average number of trucks in the whole system (queues + service),
   * rectangle rule over the snapshot cadence. Always computed — the area
   * accumulator runs even when series collection is disabled.
   */
  meanInSystem: number | null;
  /**
   * Mean sojourn (arrival → departure) over ALL arrivals, with trucks
   * still in flight at the horizon counted up to the horizon end
   * (truncated sojourn). Unlike avgSystemMin (completed trucks only),
   * this is the W that Little's Law needs for a terminating run.
   */
  meanSojournAllMin: number;
  /** Gate server-minutes available across all lanes over the horizon. */
  gateOpenServerMin: number;
}

/** Options for `runSimulation`. */
export interface RunOptions {
  /**
   * When false, skip collecting the snapshot series and wait samples
   * (used by Monte Carlo, which only needs KPIs). Default true.
   */
  includeSeries?: boolean;
}

/** Optional callback invoked with each snapshot as the sim runs. */
export type SnapshotCallback = (snapshot: Snapshot) => void;
