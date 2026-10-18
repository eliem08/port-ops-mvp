/**
 * lib/pareto.ts
 *
 * Bi-objective Pareto frontier: total wait vs rescheduled trucks.
 *
 * Why these two objectives? CO₂ is a linear function of total wait in this
 * model (idle fuel × emission factor), so waiting-vs-CO₂ is a degenerate
 * pair — every point would lie on a line. Waiting vs reschedules is the
 * genuinely conflicting trade-off: spreading trucks to cut waiting moves
 * more trucks out of their preferred windows, and vice versa. (Ancestor:
 * Chen, Govindan & Golias 2013, bi-objective TAS — see lib/formulation.ts.)
 *
 * Method: weight sweep (scalarization). For λ ∈ Λ, minimize
 *   λ · (totalWait / (n·60)) + (1−λ) · (rescheduled / n)
 * via the weighted cost function (lib/optimizer.ts), SA-refined, then
 * filter to mutually non-dominated points on the RAW objectives.
 *
 * Honesty: scalarization with a convex combination can miss points in
 * non-convex regions of the true frontier, and SA refinement is heuristic —
 * the returned points are mutually non-dominated approximations of the true
 * Pareto frontier, not proven Pareto-optimal. The panel says so.
 */

import type { BookingRequest, SlotAssignment } from './types';
import { optimizeSlots, scorePlan } from './optimizer';

export interface ParetoPoint {
  /** Scalarization weight λ (1 = minimize wait only, 0 = minimize reschedules only). */
  lambda: number;
  /** Raw total modelled wait across the plan (minutes). */
  totalWait: number;
  /** Raw number of rescheduled trucks. */
  rescheduled: number;
  /** Average wait per truck (minutes). */
  avgWait: number;
  /** Reschedule rate (0..1). */
  rescheduleRate: number;
  /** The plan achieving this point (SA-refined). */
  assignments: SlotAssignment[];
}

export interface ParetoOptions {
  /** λ values to sweep (default 0, 0.1, …, 1). */
  lambdas?: number[];
  seed?: number;
  /** Optimizer method for each sweep point (default 'annealed'). */
  method?: 'greedy' | 'annealed';
}

export function paretoFrontier(
  requests: BookingRequest[],
  opts: ParetoOptions = {},
): ParetoPoint[] {
  const n = requests.length;
  if (n === 0) return [];
  const lambdas = opts.lambdas ?? Array.from({ length: 11 }, (_, i) => i / 10);
  const seed = opts.seed ?? 42;
  const method = opts.method ?? 'annealed';
  const waitScale = Math.max(1, n * 60);

  const raw: ParetoPoint[] = [];
  for (const lambda of lambdas) {
    const assignments = optimizeSlots(requests, {
      seed,
      method,
      overbook: false,
      weights: {
        peak: 0,
        terminal: 0,
        wait: lambda / waitScale,
        reschedule: (1 - lambda) / n,
      },
    });
    const s = scorePlan(assignments, requests);
    raw.push({
      lambda,
      totalWait: Math.round(s.totalWait * 100) / 100,
      rescheduled: s.rescheduled,
      avgWait: Math.round(s.avgWait * 100) / 100,
      rescheduleRate: Math.round((s.rescheduled / n) * 1000) / 1000,
      assignments,
    });
  }

  // Dedupe identical (totalWait, rescheduled) points, keeping the first λ.
  const seen = new Map<string, ParetoPoint>();
  for (const p of raw) {
    const key = `${p.totalWait}|${p.rescheduled}`;
    if (!seen.has(key)) seen.set(key, p);
  }
  const deduped = [...seen.values()];

  // Non-domination filter (minimize both objectives). Point p is dominated
  // if some q has q.wait ≤ p.wait AND q.resched ≤ p.resched with one strict.
  const frontier = deduped.filter(
    (p) =>
      !deduped.some(
        (q) =>
          q !== p &&
          q.totalWait <= p.totalWait + 1e-9 &&
          q.rescheduled <= p.rescheduled &&
          (q.totalWait < p.totalWait - 1e-9 || q.rescheduled < p.rescheduled),
      ),
  );

  // Sort by wait ascending (reschedules then descend — a property of any
  // non-dominated set, asserted in tests).
  frontier.sort((a, b) => a.totalWait - b.totalWait || a.rescheduled - b.rescheduled);
  return frontier;
}
