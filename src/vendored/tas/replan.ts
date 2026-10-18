/**
 * lib/replan.ts
 *
 * Live replanning: the day is already running and reality diverges from the
 * plan. A dispatcher marks trucks late or no-show; this module re-optimizes
 * the REST of the day around what already happened.
 *
 * Rules (deliberate, and visible in the UI):
 *   - CONFIRMED slots are frozen: any assignment whose slot starts before
 *     `nowMin` already happened (or is being served) and is never moved.
 *   - NO-SHOW trucks are removed from the plan. Their slot is freed.
 *   - LATE trucks are removed from their old slot and re-inserted as
 *     fresh demand with a preferred window starting at
 *     max(nowMin, oldSlotStart + lateByMin) — they cannot be placed in the
 *     past, and they keep their original request (company, cargo, terminal).
 *   - Every other unserved truck is re-optimized together with the late
 *     ones, on the same cost function as the original plan, with frozen
 *     slots counted as occupied capacity.
 *
 * The result reports exactly what changed (moved trucks, freed slots, KPI
 * deltas) so a dispatcher can approve the new plan before it goes live.
 * Pure functions — no I/O.
 */

import type {
  BookingRequest,
  SlotAssignment,
  OptimizerMethod,
} from './types';
import { DAY_END_MIN, SLOT_MINUTES } from './types';
import { optimizeSlots, scorePlan } from './optimizer';

export interface Disruption {
  requestId: string;
  kind: 'no-show' | 'late';
  /** Minutes late (late only). Defaults to 30. */
  lateByMin?: number;
}

export interface MovedTruck {
  requestId: string;
  fromGate: number;
  fromSlotStart: number;
  toGate: number;
  toSlotStart: number;
}

export interface ReplanResult {
  /** The new full-day plan: frozen + re-optimized assignments. */
  after: SlotAssignment[];
  /** The plan before replanning (unchanged input, for before/after UI). */
  before: SlotAssignment[];
  /** Trucks whose slot changed (late re-placements + displaced trucks). */
  moved: MovedTruck[];
  /** Requests removed as no-shows. */
  removedNoShows: string[];
  /** Requests re-placed because they were late. */
  lateReplaced: string[];
  /** Frozen (confirmed) assignments — identical in before and after. */
  frozen: SlotAssignment[];
  /** Before/after score on the shared optimizer cost function. */
  beforeScore: ReturnType<typeof scorePlan>;
  afterScore: ReturnType<typeof scorePlan>;
}

export interface ReplanOptions {
  /** Optimization strategy for the re-plan (default 'greedy'). */
  method?: OptimizerMethod;
  seed?: number;
  overbook?: boolean;
}

/**
 * Re-optimize the remainder of a day around disruptions.
 *
 * @param requests    All requests for the day (the plan's demand).
 * @param assignments Current plan for the day.
 * @param disruptions Trucks that are late or no-show.
 * @param nowMin      Current time, minutes since midnight. Slots before
 *                    this are confirmed and frozen.
 */
export function replanDay(
  requests: BookingRequest[],
  assignments: SlotAssignment[],
  disruptions: Disruption[],
  nowMin: number,
  opts: ReplanOptions = {},
): ReplanResult {
  const byId = new Map(requests.map((r) => [r.id, r]));
  const byAssign = new Map(assignments.map((a) => [a.requestId, a]));
  const disruptionById = new Map(disruptions.map((d) => [d.requestId, d]));

  // No actionable disruption: nothing to replan. Return the plan unchanged
  // rather than reshuffling it for no reason (a re-optimization with a
  // different seed could otherwise move trucks nobody asked to move).
  const actionable = disruptions.some((d) => {
    const a = byAssign.get(d.requestId);
    return a !== undefined && a.slotStart >= nowMin;
  });
  if (!actionable) {
    return {
      after: [...assignments],
      before: [...assignments],
      moved: [],
      removedNoShows: [],
      lateReplaced: [],
      frozen: assignments.filter((a) => a.slotStart < nowMin),
      beforeScore: scorePlan(assignments, requests),
      afterScore: scorePlan(assignments, requests),
    };
  }
  // The day is over: no usable slots remain. Return the plan unchanged —
  // disruptions can no longer be actioned.
  if (nowMin > DAY_END_MIN - SLOT_MINUTES) {
    return {
      after: [...assignments],
      before: [...assignments],
      moved: [],
      removedNoShows: [],
      lateReplaced: [],
      frozen: [...assignments],
      beforeScore: scorePlan(assignments, requests),
      afterScore: scorePlan(assignments, requests),
    };
  }

  const frozen: SlotAssignment[] = [];
  const removedNoShows: string[] = [];
  const lateReplaced: string[] = [];
  const replanRequests: BookingRequest[] = [];

  for (const a of assignments) {
    const req = byId.get(a.requestId);
    if (!req) continue;
    const d = disruptionById.get(a.requestId);

    if (a.slotStart < nowMin) {
      // Already served / in service — frozen, even if flagged late
      // (a truck already at the gate cannot be "re-planned").
      frozen.push(a);
      continue;
    }

    if (d?.kind === 'no-show') {
      removedNoShows.push(a.requestId);
      continue; // slot freed
    }

    if (d?.kind === 'late') {
      const lateBy = Math.max(0, d.lateByMin ?? 30);
      const earliest = Math.min(
        DAY_END_MIN - SLOT_MINUTES,
        Math.max(nowMin, a.slotStart + lateBy),
      );
      lateReplaced.push(a.requestId);
      replanRequests.push({
        ...req,
        preferredStart: earliest,
        preferredEnd: DAY_END_MIN,
      });
      continue;
    }

    // Unserved, undisrupted: re-optimize with its original window.
    replanRequests.push(req);
  }

  // Requests in `requests` but missing from the plan (shouldn't happen, but
  // be safe) are treated as fresh demand.
  for (const req of requests) {
    if (!byAssign.has(req.id) && !disruptionById.has(req.id)) {
      replanRequests.push(req);
    }
  }

  // Re-optimize the remainder with frozen slots as blocked capacity, and
  // never place anything before "now".
  const blocked = frozen.map((a) => ({ gate: a.gate, slotStart: a.slotStart }));
  const fresh = optimizeSlots(replanRequests, {
    seed: opts.seed ?? 7,
    overbook: opts.overbook ?? false,
    method: opts.method ?? 'greedy',
    blocked,
    earliestSlotStart: nowMin,
  });

  const after = [...frozen, ...fresh].sort(
    (a, b) => a.slotStart - b.slotStart || a.gate - b.gate,
  );

  const beforeMap = new Map(assignments.map((a) => [a.requestId, a]));
  const moved: MovedTruck[] = [];
  for (const a of after) {
    const before = beforeMap.get(a.requestId);
    if (before && (before.slotStart !== a.slotStart || before.gate !== a.gate)) {
      moved.push({
        requestId: a.requestId,
        fromGate: before.gate,
        fromSlotStart: before.slotStart,
        toGate: a.gate,
        toSlotStart: a.slotStart,
      });
    }
  }

  return {
    after,
    before: [...assignments],
    moved,
    removedNoShows,
    lateReplaced,
    frozen,
    beforeScore: scorePlan(assignments, requests),
    afterScore: scorePlan(after, requests),
  };
}
