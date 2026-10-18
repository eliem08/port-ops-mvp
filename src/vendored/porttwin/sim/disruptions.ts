/**
 * Disruption scenarios for the Port of Casablanca digital twin.
 *
 * Four disruption types, each toggleable and combinable with the others and
 * with any policy preset (crisis / TAS / TAS + night gate):
 *
 *  - Crane breakdown: one yard crane is out of service for a window.
 *  - Vessel bunching: extra trucks arrive in a tight tide window (2–3
 *    vessels berthing together), as if several vessels arrived on one tide.
 *  - Gate closure: one gate lane is closed for a shift.
 *  - Weather slowdown: yard productivity drops (rain/wind), so yard
 *    handling times stretch by 1 / productivityFactor.
 *
 * All times are hours since simulation start (0 = midnight of the modelled
 * day). Disruptions are deliberately stylized: they perturb the same
 * three-stage queue the base engine models, so their effects are comparable
 * across scenarios. They do NOT model vessel schedules, tides, or crane
 * maintenance logistics — see README limitations.
 */

/** One yard crane out of service for [startHour, startHour + durationHours). */
export interface CraneBreakdown {
  enabled: boolean;
  /** Index of the crane that breaks down (0-based). */
  craneIndex: number;
  startHour: number;
  durationHours: number;
}

/** A burst of extra truck arrivals inside one tide window. */
export interface VesselBunching {
  enabled: boolean;
  /** Extra trucks injected across the window (≈ 2 vessels ≈ 300 trucks). */
  extraTrucks: number;
  windowStartHour: number;
  windowHours: number;
}

/** One gate lane closed for [startHour, startHour + durationHours). */
export interface GateClosure {
  enabled: boolean;
  /** Index of the gate that closes (0-based). */
  gateIndex: number;
  startHour: number;
  durationHours: number;
}

/** Yard productivity drops for a window (rain, wind, dust storm). */
export interface WeatherSlowdown {
  enabled: boolean;
  startHour: number;
  durationHours: number;
  /**
   * Yard productivity during the window, 0.5–1.0.
   * 0.7 means a 30% slowdown → handling times are divided by 0.7.
   */
  productivityFactor: number;
}

/** All four disruption types in one bundle. */
export interface Disruptions {
  craneBreakdown: CraneBreakdown;
  vesselBunching: VesselBunching;
  gateClosure: GateClosure;
  weatherSlowdown: WeatherSlowdown;
}

/** All disruptions off, with sensible defaults when switched on. */
export const DEFAULT_DISRUPTIONS: Disruptions = {
  craneBreakdown: {
    enabled: false,
    craneIndex: 0,
    startHour: 8,
    durationHours: 4,
  },
  vesselBunching: {
    enabled: false,
    extraTrucks: 300,
    windowStartHour: 7,
    windowHours: 2,
  },
  gateClosure: {
    enabled: false,
    gateIndex: 0,
    startHour: 6,
    durationHours: 8,
  },
  weatherSlowdown: {
    enabled: false,
    startHour: 10,
    durationHours: 3,
    productivityFactor: 0.7,
  },
};

/** Deep-clone a disruptions bundle (never mutate DEFAULT_DISRUPTIONS). */
export function cloneDisruptions(d: Disruptions): Disruptions {
  return {
    craneBreakdown: { ...d.craneBreakdown },
    vesselBunching: { ...d.vesselBunching },
    gateClosure: { ...d.gateClosure },
    weatherSlowdown: { ...d.weatherSlowdown },
  };
}

/** True when at least one disruption is switched on. */
export function anyDisruptionActive(d: Disruptions | undefined): boolean {
  if (!d) return false;
  return (
    d.craneBreakdown.enabled ||
    d.vesselBunching.enabled ||
    d.gateClosure.enabled ||
    d.weatherSlowdown.enabled
  );
}

/** True when sim-minute t falls inside [startHour, startHour + duration). */
export function inWindow(
  tMin: number,
  startHour: number,
  durationHours: number
): boolean {
  const start = startHour * 60;
  return tMin >= start && tMin < start + durationHours * 60;
}

/** True when yard crane `index` is broken down at sim-minute t. */
export function craneDownAt(
  d: Disruptions | undefined,
  index: number,
  tMin: number
): boolean {
  if (!d || !d.craneBreakdown.enabled) return false;
  if (index !== d.craneBreakdown.craneIndex) return false;
  return inWindow(tMin, d.craneBreakdown.startHour, d.craneBreakdown.durationHours);
}

/** True when gate lane `index` is closed at sim-minute t. */
export function gateClosedAt(
  d: Disruptions | undefined,
  index: number,
  tMin: number
): boolean {
  if (!d || !d.gateClosure.enabled) return false;
  if (index !== d.gateClosure.gateIndex) return false;
  return inWindow(tMin, d.gateClosure.startHour, d.gateClosure.durationHours);
}

/**
 * Yard productivity factor at sim-minute t: 1.0 normally, or the weather
 * factor while the weather window is active. Clamped to (0, 1].
 */
export function yardProductivityAt(
  d: Disruptions | undefined,
  tMin: number
): number {
  if (!d || !d.weatherSlowdown.enabled) return 1;
  if (
    !inWindow(
      tMin,
      d.weatherSlowdown.startHour,
      d.weatherSlowdown.durationHours
    )
  ) {
    return 1;
  }
  const f = d.weatherSlowdown.productivityFactor;
  return Math.min(1, Math.max(0.05, f));
}

/** Short human-readable summary of the active disruptions. */
export function describeDisruptions(d: Disruptions | undefined): string[] {
  if (!d) return [];
  const out: string[] = [];
  if (d.craneBreakdown.enabled) {
    out.push(
      `Crane #${d.craneBreakdown.craneIndex + 1} down ${d.craneBreakdown.startHour}:00–${
        d.craneBreakdown.startHour + d.craneBreakdown.durationHours
      }:00`
    );
  }
  if (d.vesselBunching.enabled) {
    out.push(
      `+${d.vesselBunching.extraTrucks} trucks bunched ${d.vesselBunching.windowStartHour}:00–${
        d.vesselBunching.windowStartHour + d.vesselBunching.windowHours
      }:00`
    );
  }
  if (d.gateClosure.enabled) {
    out.push(
      `Gate #${d.gateClosure.gateIndex + 1} closed ${d.gateClosure.startHour}:00–${
        d.gateClosure.startHour + d.gateClosure.durationHours
      }:00`
    );
  }
  if (d.weatherSlowdown.enabled) {
    const pct = Math.round((1 - d.weatherSlowdown.productivityFactor) * 100);
    out.push(
      `Weather: yard −${pct}% ${d.weatherSlowdown.startHour}:00–${
        d.weatherSlowdown.startHour + d.weatherSlowdown.durationHours
      }:00`
    );
  }
  return out;
}
