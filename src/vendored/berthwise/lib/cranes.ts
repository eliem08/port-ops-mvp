import type {
  Assignment,
  Berth,
  BerthPlan,
  CraneAssignment,
  CraneSchedule,
  TideWindow,
  Vessel,
} from "./types";
import { cranesForVessel, CRANE_POOL_LIMIT } from "./economics";
import { needsTideWindow, nextTideWindowStart, generateTideWindows } from "./tide";
import { assertPlanningInputs } from "./validate";

/**
 * Crane scheduling against a shared quay-crane pool.
 *
 * The berth plan's per-berth vessel *sequences* are fixed; this stage assigns
 * concrete start times and crane counts. Cranes are a port-wide shared
 * resource: at no instant may simultaneous usage exceed the pool limit.
 *
 * Scheduling is a deterministic head-of-sequence list schedule: at each step
 * the candidate is the head vessel of every berth's queue, and the one with
 * the earliest feasible start goes first. A vessel's start is the earliest
 * time satisfying (a) its ETA, (b) its berth being free, (c) a tide window if
 * it is deep-draft, and (d) enough free cranes for its whole handling window.
 * Because starts only ever move later, the result is always feasible and the
 * pool is never over-allocated.
 */

interface CraneInterval {
  start: number;
  end: number;
  cranes: number;
}

export interface ScheduleCranesOptions {
  poolLimit?: number;
  tidesEnabled?: boolean;
  tideWindows?: TideWindow[];
  /** Per-vessel "not before" floors (used to honour drag-and-drop positions). */
  notBefore?: Map<string, number>;
}

function maxUsageInWindow(intervals: CraneInterval[], start: number, end: number): number {
  const events: Array<{ t: number; delta: number }> = [];
  for (const iv of intervals) {
    if (iv.end <= start || iv.start >= end) continue;
    events.push({ t: Math.max(iv.start, start), delta: iv.cranes });
    events.push({ t: Math.min(iv.end, end), delta: -iv.cranes });
  }
  // Endings processed before starts at the same timestamp (half-open intervals).
  events.sort((a, b) => a.t - b.t || a.delta - b.delta);
  let current = 0;
  let max = 0;
  for (const e of events) {
    current += e.delta;
    if (current > max) max = current;
  }
  return max;
}

/**
 * Earliest start >= `fromTime` for a vessel needing `needed` cranes for
 * `duration` hours, honouring tide windows (deep-draft) and the crane pool.
 */
function earliestFeasibleStart(
  fromTime: number,
  duration: number,
  needed: number,
  deepDraft: boolean,
  intervals: CraneInterval[],
  poolLimit: number,
  tideWindows: TideWindow[],
): number {
  let t = fromTime;
  // Bounded loop: each iteration jumps to a later event time or tide window.
  for (let iter = 0; iter < 10000; iter++) {
    if (deepDraft) t = nextTideWindowStart(t, tideWindows);
    const end = t + duration;
    const peak = maxUsageInWindow(intervals, t, end);
    if (peak + needed <= poolLimit) return t;
    // Jump to the earliest interval end after t that overlaps the window.
    let nextT = Number.POSITIVE_INFINITY;
    for (const iv of intervals) {
      if (iv.end > t && iv.start < end && iv.end < nextT) nextT = iv.end;
    }
    if (!Number.isFinite(nextT)) return t; // should not happen; pool >= needed
    t = nextT;
  }
  return t;
}

export function scheduleCranes(
  plan: BerthPlan,
  vessels: Vessel[],
  berths: Berth[],
  opts: ScheduleCranesOptions = {},
): { plan: BerthPlan; schedule: CraneSchedule } {
  const poolLimit = opts.poolLimit ?? CRANE_POOL_LIMIT;
  assertPlanningInputs(vessels, berths);
  if (!Number.isFinite(poolLimit) || poolLimit < 0) {
    throw new Error(`invalid input: poolLimit must be a finite number >= 0 (received ${String(poolLimit)})`);
  }
  const tidesEnabled = opts.tidesEnabled ?? false;

  const vesselById = new Map(vessels.map((v) => [v.id, v]));

  // Reconstruct per-berth sequences from the plan (sorted by start time).
  const queues = new Map<string, string[]>();
  for (const berth of berths) queues.set(berth.id, []);
  for (const berth of berths) {
    const list = plan.assignments
      .filter((a) => a.berthId === berth.id)
      .sort((a, b) => a.startHours - b.startHours || (a.vesselId < b.vesselId ? -1 : 1))
      .map((a) => a.vesselId);
    queues.set(berth.id, list);
  }

  // Horizon for tide windows: generous upper bound.
  const horizon =
    Math.max(0, ...vessels.map((v) => v.etaHours)) +
    vessels.reduce((s, v) => s + v.handlingHours, 0) +
    48;
  const tideWindows = opts.tideWindows ?? generateTideWindows(horizon);

  const berthAvail = new Map<string, number>();
  for (const berth of berths) berthAvail.set(berth.id, 0);

  const intervals: CraneInterval[] = [];
  const newAssignments: Assignment[] = [];
  const craneAssignments: CraneAssignment[] = [];
  // Every berth gets an entry (0 when idle) so downstream means over
  // berthBusyHours are taken over ALL berths, not just the busy ones.
  const berthBusyHours: Record<string, number> = {};
  for (const berth of berths) berthBusyHours[berth.id] = 0;
  let totalWaitingHours = 0;
  let makespanHours = 0;
  let totalCraneHours = 0;

  const remaining = () => [...queues.values()].some((q) => q.length > 0);

  while (remaining()) {
    // Pick the head vessel with the earliest feasible base start.
    let best: { vessel: Vessel; berth: Berth; base: number } | null = null;
    for (const berth of berths) {
      const queue = queues.get(berth.id);
      if (!queue || queue.length === 0) continue;
      const vessel = vesselById.get(queue[0]);
      if (!vessel) continue;
      const floor = opts.notBefore?.get(vessel.id) ?? 0;
      const base = Math.max(vessel.etaHours, berthAvail.get(berth.id) ?? 0, floor);
      if (
        best === null ||
        base < best.base ||
        (base === best.base &&
          (berth.id < best.berth.id ||
            (berth.id === best.berth.id && vessel.id < best.vessel.id)))
      ) {
        best = { vessel, berth, base };
      }
    }
    if (!best) break;

    const { vessel, berth } = best;
    // A single vessel can never use more cranes than the whole pool holds.
    const needed = Math.min(cranesForVessel(vessel, berth), poolLimit);
    const deepDraft = tidesEnabled && needsTideWindow(vessel);
    const start = earliestFeasibleStart(
      best.base,
      vessel.handlingHours,
      needed,
      deepDraft,
      intervals,
      poolLimit,
      tideWindows,
    );
    const end = start + vessel.handlingHours;
    const waiting = Math.max(0, start - vessel.etaHours);

    newAssignments.push({ vesselId: vessel.id, berthId: berth.id, startHours: start, endHours: end, waitingHours: waiting });
    craneAssignments.push({
      vesselId: vessel.id,
      berthId: berth.id,
      cranes: needed,
      craneHours: vessel.handlingHours * needed,
      startHours: start,
      endHours: end,
    });
    intervals.push({ start, end, cranes: needed });

    berthAvail.set(berth.id, end);
    berthBusyHours[berth.id] = (berthBusyHours[berth.id] ?? 0) + vessel.handlingHours;
    totalWaitingHours += waiting;
    totalCraneHours += vessel.handlingHours * needed;
    if (end > makespanHours) makespanHours = end;

    queues.get(berth.id)?.shift();
  }

  // Unassigned vessels carry over unchanged.
  const unassigned = [...plan.unassigned];

  const outPlan: BerthPlan = {
    assignments: newAssignments,
    unassigned,
    totalWaitingHours,
    makespanHours,
    berthBusyHours,
  };

  // Hourly midpoint usage samples for the chart.
  const usageSeries: CraneSchedule["usageSeries"] = [];
  let peakUsage = 0;
  for (let h = 0; h <= Math.ceil(makespanHours); h++) {
    const mid = h + 0.5;
    const inUse = intervals.reduce(
      (sum, iv) => sum + (mid >= iv.start && mid < iv.end ? iv.cranes : 0),
      0,
    );
    if (inUse > peakUsage) peakUsage = inUse;
    usageSeries.push({ hour: h, cranesInUse: inUse });
  }

  const avgUtilizationPct =
    makespanHours > 0 && poolLimit > 0
      ? Math.round((totalCraneHours / (poolLimit * makespanHours)) * 1000) / 10
      : 0;

  return {
    plan: outPlan,
    schedule: {
      assignments: craneAssignments,
      peakUsage,
      poolLimit,
      avgUtilizationPct,
      totalCraneHours,
      usageSeries,
    },
  };
}

/**
 * Crane-pool feasibility check for a proposed drop: would the vessel fit
 * into the pool during [startHours, startHours + handlingHours) alongside
 * the *other* assignments (the dragged vessel's own current assignment is
 * excluded)? Returns the free crane count in the tightest hour, or -1 when
 * the window is infeasible.
 */
export function cranesFreeAt(
  assignments: Assignment[],
  vessels: Vessel[],
  berths: Berth[],
  vesselId: string,
  targetBerthId: string,
  startHours: number,
  poolLimit: number = CRANE_POOL_LIMIT,
): number {
  assertPlanningInputs(vessels, berths);
  const vesselById = new Map(vessels.map((v) => [v.id, v]));
  const berthById = new Map(berths.map((b) => [b.id, b]));
  const vessel = vesselById.get(vesselId);
  const berth = berthById.get(targetBerthId);
  if (!vessel || !berth) return -1;

  const needed = Math.min(cranesForVessel(vessel, berth), poolLimit);
  const end = startHours + vessel.handlingHours;
  const intervals: CraneInterval[] = [];
  for (const a of assignments) {
    if (a.vesselId === vesselId) continue;
    const v = vesselById.get(a.vesselId);
    const b = berthById.get(a.berthId);
    if (!v || !b) continue;
    intervals.push({
      start: a.startHours,
      end: a.endHours,
      cranes: cranesForVessel(v, b),
    });
  }
  const peak = maxUsageInWindow(intervals, startHours, end);
  return poolLimit - peak - needed;
}
