/**
 * lib/annealer.ts
 *
 * A small, generic, deterministic simulated-annealing engine.
 *
 * Simulated annealing improves a starting solution by proposing random
 * neighbour moves and accepting them with probability exp(-Δcost / T),
 * where T (temperature) cools geometrically from startTemp to endTemp.
 * Worse moves are sometimes accepted early (escaping local optima), almost
 * never late (converging). The best state seen is always kept, so the
 * result can never be worse than the starting solution.
 *
 * The engine is deliberately generic — it knows nothing about trucks or
 * slots. Callers supply: the initial state, a clone function, a cost
 * function, and a neighbour function that mutates the state in place.
 * The engine snapshots the state before each move and restores it on
 * rejection, so callers never write revert logic.
 *
 * Deterministic given a seeded RNG: same inputs, same trajectory.
 */

export interface AnnealOptions {
  /** Neighbour moves attempted (default 2500). */
  iterations?: number;
  /** Starting temperature (default 6 — same units as the cost function). */
  startTemp?: number;
  /** Final temperature (default 0.02). */
  endTemp?: number;
  /** Seeded RNG in [0, 1). Required for determinism. */
  rng: () => number;
}

export interface AnnealResult<S> {
  /** Best state seen (a clone — safe to mutate). */
  best: S;
  /** Cost of the best state. */
  bestCost: number;
  /** Number of neighbour moves accepted (improving + uphill). */
  accepted: number;
  /** Number of iterations actually run. */
  iterations: number;
}

export function simulatedAnneal<S>(args: {
  initial: S;
  clone: (s: S) => S;
  cost: (s: S) => number;
  /** Mutates `state` in place to a neighbouring state. */
  neighbor: (state: S, rng: () => number) => void;
  options: AnnealOptions;
}): AnnealResult<S> {
  const { initial, clone, cost, neighbor, options } = args;
  const iterations = options.iterations ?? 2500;
  const startTemp = options.startTemp ?? 6;
  const endTemp = options.endTemp ?? 0.02;
  const rng = options.rng;

  let state = clone(initial);
  let currentCost = cost(state);
  let best = clone(state);
  let bestCost = currentCost;
  let accepted = 0;

  for (let i = 0; i < iterations; i += 1) {
    // Geometric cooling: T goes from startTemp to endTemp over the run.
    const frac = iterations <= 1 ? 1 : i / (iterations - 1);
    const temp = startTemp * Math.pow(endTemp / startTemp, frac);

    const snapshot = clone(state);
    neighbor(state, rng);
    const nextCost = cost(state);

    const delta = nextCost - currentCost;
    const accept =
      delta <= 0 || rng() < Math.exp(-delta / Math.max(temp, 1e-9));
    if (accept) {
      currentCost = nextCost;
      accepted += 1;
      if (nextCost < bestCost - 1e-9) {
        best = clone(state);
        bestCost = nextCost;
      }
    } else {
      state = snapshot; // revert
    }
  }

  return { best, bestCost, accepted, iterations };
}
