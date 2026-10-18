import type { Berth, Box, Vessel } from "./types";

/**
 * Shared input validation for the planning library.
 *
 * Every public entry point validates its inputs before doing any work, so
 * malformed data fails fast with a clear message instead of producing a
 * silently invalid schedule (NaN starts, negative durations, phantom
 * vessels swallowed by Map lookups, …).
 */

function fail(what: string, received: unknown): never {
  throw new Error(`invalid input: ${what} (received ${String(received)})`);
}

function assertFinite(value: number, name: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${name} must be a finite number`, value);
  }
}

function assertNonEmptyId(id: string, kind: string): void {
  if (typeof id !== "string" || id.length === 0) {
    fail(`${kind} id must be a non-empty string`, id);
  }
}

export function assertValidVessel(vessel: Vessel): void {
  if (!vessel || typeof vessel !== "object") fail("vessel must be an object", vessel);
  assertNonEmptyId(vessel.id, "vessel");
  assertFinite(vessel.etaHours, `vessel ${vessel.id}: etaHours`);
  assertFinite(vessel.handlingHours, `vessel ${vessel.id}: handlingHours`);
  if (vessel.handlingHours <= 0) {
    fail(`vessel ${vessel.id}: handlingHours must be > 0`, vessel.handlingHours);
  }
  assertFinite(vessel.lengthM, `vessel ${vessel.id}: lengthM`);
  if (vessel.lengthM <= 0) {
    fail(`vessel ${vessel.id}: lengthM must be > 0`, vessel.lengthM);
  }
  assertFinite(vessel.draftM, `vessel ${vessel.id}: draftM`);
  if (vessel.draftM < 0) {
    fail(`vessel ${vessel.id}: draftM must be >= 0`, vessel.draftM);
  }
  assertFinite(vessel.teu, `vessel ${vessel.id}: teu`);
  if (vessel.teu < 0) {
    fail(`vessel ${vessel.id}: teu must be >= 0`, vessel.teu);
  }
}

export function assertValidBerth(berth: Berth): void {
  if (!berth || typeof berth !== "object") fail("berth must be an object", berth);
  assertNonEmptyId(berth.id, "berth");
  assertFinite(berth.lengthM, `berth ${berth.id}: lengthM`);
  if (berth.lengthM <= 0) {
    fail(`berth ${berth.id}: lengthM must be > 0`, berth.lengthM);
  }
  assertFinite(berth.cranes, `berth ${berth.id}: cranes`);
  if (!Number.isInteger(berth.cranes) || berth.cranes < 0) {
    fail(`berth ${berth.id}: cranes must be a non-negative integer`, berth.cranes);
  }
}

/**
 * Validate a (vessels, berths) pair: arrays, unique ids, per-record fields.
 * Empty arrays are allowed (they yield an empty plan).
 */
export function assertPlanningInputs(vessels: Vessel[], berths: Berth[]): void {
  if (!Array.isArray(vessels)) fail("vessels must be an array", vessels);
  if (!Array.isArray(berths)) fail("berths must be an array", berths);
  const seenVessels = new Set<string>();
  for (const vessel of vessels) {
    assertValidVessel(vessel);
    if (seenVessels.has(vessel.id)) fail("duplicate vessel id", vessel.id);
    seenVessels.add(vessel.id);
  }
  const seenBerths = new Set<string>();
  for (const berth of berths) {
    assertValidBerth(berth);
    if (seenBerths.has(berth.id)) fail("duplicate berth id", berth.id);
    seenBerths.add(berth.id);
  }
}

/**
 * Retrieval ranks must be a permutation of 1..N: the rehandle counters walk
 * ranks in order, and a missing or duplicated rank would silently skip boxes
 * and undercount the true yard work.
 */
export function assertRankPermutation(boxes: Box[]): void {
  if (!Array.isArray(boxes)) fail("boxes must be an array", boxes);
  const seen = new Set<number>();
  for (const box of boxes) {
    if (!box || typeof box !== "object") fail("box must be an object", box);
    assertNonEmptyId(box.id, "box");
    if (!Number.isInteger(box.retrievalRank) || box.retrievalRank < 1 || box.retrievalRank > boxes.length) {
      fail(
        `box ${box.id}: retrievalRank must be an integer in 1..${boxes.length}`,
        box.retrievalRank,
      );
    }
    if (seen.has(box.retrievalRank)) {
      fail("duplicate retrievalRank", box.retrievalRank);
    }
    seen.add(box.retrievalRank);
  }
}
