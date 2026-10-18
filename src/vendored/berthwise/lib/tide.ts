import type { TideWindow, Vessel } from "./types";

/**
 * Tide windows for the Port of Casablanca.
 *
 * Model: semidiurnal tide, period 12.42h, first high-water centre at t = 3.0h
 * after the planning horizon starts, with a ±2.0h usable window around each
 * high water. This is a stylised model of the real semidiurnal cycle, not a
 * harmonic tide-table prediction.
 *
 * Constraint (entry-only): a deep-draft vessel may only *start* (berth) inside
 * a high-water window. Departure is unrestricted — the vessel leaves lighter,
 * so the entry constraint is the binding one.
 */

/** Hours between successive high waters. */
export const TIDE_PERIOD_HOURS = 12.42;
/** Centre of the first high-water window, hours from t0. */
export const TIDE_FIRST_HIGH_WATER_HOURS = 3.0;
/** Usable half-width around each high water, in hours. */
export const TIDE_WINDOW_HALF_WIDTH_HOURS = 2.0;
/** Vessels drawing at least this much need a tide window to enter. */
export const DEEP_DRAFT_THRESHOLD_M = 12.0;

/** A vessel needs a tide window to enter iff it draws at/above threshold. */
export function needsTideWindow(vessel: Vessel): boolean {
  return vessel.draftM >= DEEP_DRAFT_THRESHOLD_M;
}

/** All tide windows whose start is at or before `horizonHours`. */
export function generateTideWindows(horizonHours: number): TideWindow[] {
  const windows: TideWindow[] = [];
  let centre = TIDE_FIRST_HIGH_WATER_HOURS;
  while (centre - TIDE_WINDOW_HALF_WIDTH_HOURS <= horizonHours) {
    windows.push({
      startHours: centre - TIDE_WINDOW_HALF_WIDTH_HOURS,
      endHours: centre + TIDE_WINDOW_HALF_WIDTH_HOURS,
    });
    centre += TIDE_PERIOD_HOURS;
  }
  return windows;
}

/** True when `t` falls inside any window (start inclusive, end exclusive). */
export function isInTideWindow(t: number, windows: TideWindow[]): boolean {
  for (const w of windows) {
    if (t >= w.startHours && t < w.endHours) return true;
  }
  return false;
}

/**
 * Earliest time >= `t` that lies inside a tide window. If `t` is already
 * inside a window it is returned unchanged. Windows must cover the horizon;
 * if `t` is past the last window, the next theoretical window start is
 * returned (callers should size the horizon generously).
 */
export function nextTideWindowStart(t: number, windows: TideWindow[]): number {
  for (const w of windows) {
    if (t < w.endHours) {
      // Either inside this window (keep t) or in the gap before it.
      return t >= w.startHours ? t : w.startHours;
    }
  }
  // Past the last known window: extrapolate the next one.
  const last = windows[windows.length - 1];
  if (!last) return t;
  const nextStart = last.startHours + TIDE_PERIOD_HOURS;
  return Math.max(t, nextStart);
}
