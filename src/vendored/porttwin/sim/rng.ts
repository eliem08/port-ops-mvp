/**
 * Seeded pseudo-random number generator (mulberry32) plus common
 * distributions. Every stochastic draw in the simulation flows through
 * these helpers so runs are fully reproducible for a given seed.
 */

export type Rng = () => number;

/** Create a mulberry32 PRNG seeded with a 32-bit integer. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform draw in [min, max). */
export function uniform(rng: Rng, min: number, max: number): number {
  return min + (max - min) * rng();
}

/** Uniform integer draw in [min, max] inclusive. */
export function uniformInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Exponential draw with the given mean. */
export function exponential(rng: Rng, mean: number): number {
  // Guard against rng() returning exactly 0.
  return -mean * Math.log(1 - rng());
}

/**
 * Lognormal draw parameterized by desired mean and sigma (shape).
 * mu is derived so that E[X] = mean.
 */
export function lognormal(rng: Rng, mean: number, sigma: number): number {
  const mu = Math.log(mean) - (sigma * sigma) / 2;
  const z = normalStandard(rng);
  return Math.exp(mu + sigma * z);
}

/** Standard normal via Box-Muller. */
export function normalStandard(rng: Rng): number {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}
