/**
 * lib/server/stores.ts
 *
 * DEMO-ONLY in-memory entity stores for the Phase C booking API.
 * NOT a production store: data lives in the Node process, is lost on
 * restart, and is not shared across instances. No real database exists
 * in this repo by design (Phase C doctrine: minimum necessary).
 *
 * Capacity model (demo): each (terminal, gate, 30-minute slot bucket)
 * accepts at most BOOKING_CAPACITY_PER_SLOT appointments. Bookings
 * past capacity are rejected with 409 so over-booking cannot happen
 * silently through the API.
 */

import type { Appointment, Recommendation } from "../contracts";

/** Max appointments per (terminal, gate, 30-min slot bucket). Demo value. */
export const BOOKING_CAPACITY_PER_SLOT = 4;

const appointments = new Map<string, Appointment>();
const recommendations = new Map<string, Recommendation>();

/** 30-minute slot bucket key for capacity checks: "terminal|gate|bucketIndex". */
export function slotBucketKey(
  terminal: string,
  gate: string,
  startUtc: string,
): string {
  const bucket = Math.floor(Date.parse(startUtc) / (30 * 60 * 1000));
  return `${terminal}|${gate}|${bucket}`;
}

export function countInSlotBucket(
  terminal: string,
  gate: string,
  startUtc: string,
  excludeId?: string,
): number {
  const key = slotBucketKey(terminal, gate, startUtc);
  let n = 0;
  for (const a of appointments.values()) {
    if (a.id === excludeId) continue;
    if (a.status === "cancelled" || a.status === "no-show") continue;
    if (slotBucketKey(a.terminal, a.gate, a.slot.startUtc) === key) n++;
  }
  return n;
}

export const appointmentStore = {
  get: (id: string) => appointments.get(id),
  set: (a: Appointment) => {
    appointments.set(a.id, a);
  },
  list: (): Appointment[] => [...appointments.values()],
  get size() {
    return appointments.size;
  },
  /** Test/reset hook only. */
  clear: () => appointments.clear(),
};

export const recommendationStore = {
  get: (id: string) => recommendations.get(id),
  set: (r: Recommendation) => {
    recommendations.set(r.id, r);
  },
  list: (): Recommendation[] => [...recommendations.values()],
  get size() {
    return recommendations.size;
  },
  /** Test/reset hook only. */
  clear: () => recommendations.clear(),
};
