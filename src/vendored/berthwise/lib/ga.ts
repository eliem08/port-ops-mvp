import type { Berth, BerthPlan, PlanOptions, Vessel } from "./types";
import { mulberry32 } from "./rng";
import { berthFeasible, planNaive, sequencesToPlan } from "./berth";
import { assertPlanningInputs } from "./validate";
import { planEconomics } from "./economics";

/**
 * Genetic algorithm for the discrete dynamic BAP.
 *
 * Chromosome: (order, berth) — `order` is a permutation of the vessel
 * indices, `berth[i]` is the berth index assigned to vessel i (or -1 when
 * the vessel has no feasible berth and stays unassigned). Decoding: each
 * berth's sequence is the subsequence of `order` assigned to it, swept by
 * the shared sweep — so every chromosome decodes to a feasible plan.
 *
 * Operators: tournament selection, order crossover (OX) on the permutation,
 * uniform crossover on the berth vector, swap mutation on the permutation,
 * random feasible-berth reassignment, elitism (best 2 survive). All
 * randomness flows through mulberry32(seed): identical inputs → identical
 * output. Fixed population/generations (no wall-clock dependence), so the
 * run is deterministic across machines.
 */

const POPULATION = 40;
const GENERATIONS = 60;
const TOURNAMENT_SIZE = 3;
const CROSSOVER_RATE = 0.9;
const SWAP_MUTATION_RATE = 0.25;
const BERTH_MUTATION_RATE = 0.15;
const ELITE_COUNT = 2;
const DEFAULT_SEED = 42;

interface Chromosome {
  order: number[];
  berth: number[];
}

function decode(
  chrom: Chromosome,
  vessels: Vessel[],
  berths: Berth[],
  opts: PlanOptions,
): BerthPlan {
  const seqs = new Map<string, string[]>();
  for (const berth of berths) seqs.set(berth.id, []);
  for (const vesselIdx of chrom.order) {
    const berthIdx = chrom.berth[vesselIdx];
    if (berthIdx < 0) continue;
    const berth = berths[berthIdx];
    const vessel = vessels[vesselIdx];
    if (!berth || !vessel) continue;
    seqs.get(berth.id)?.push(vessel.id);
  }
  return sequencesToPlan(seqs, vessels, {
    tidesEnabled: opts.tidesEnabled ?? false,
  });
}

function fitness(
  chrom: Chromosome,
  vessels: Vessel[],
  berths: Berth[],
  opts: PlanOptions,
): number {
  const plan = decode(chrom, vessels, berths, opts);
  return planEconomics(plan, vessels, berths, opts.weights).objective;
}

function feasibleBerths(vessel: Vessel, berths: Berth[]): number[] {
  const out: number[] = [];
  berths.forEach((berth, i) => {
    if (berthFeasible(vessel, berth)) out.push(i);
  });
  return out;
}

function randomChromosome(
  vessels: Vessel[],
  berths: Berth[],
  rand: () => number,
): Chromosome {
  const order = vessels.map((_, i) => i);
  // Fisher–Yates shuffle.
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const berth = vessels.map((vessel) => {
    const feasible = feasibleBerths(vessel, berths);
    if (feasible.length === 0) return -1;
    return feasible[Math.floor(rand() * feasible.length)];
  });
  return { order, berth };
}

function greedyChromosome(
  vessels: Vessel[],
  berths: Berth[],
  opts: PlanOptions,
): Chromosome {
  // ETA order + the greedy plan's berth assignment.
  const order = vessels
    .map((v, i) => ({ v, i }))
    .sort((a, b) => a.v.etaHours - b.v.etaHours || (a.v.id < b.v.id ? -1 : 1))
    .map((x) => x.i);
  const greedyPlan = planNaive(vessels, berths, opts);
  const berthByVessel = new Map(greedyPlan.assignments.map((a) => [a.vesselId, a.berthId]));
  const berth = vessels.map((vessel) => {
    const berthId = berthByVessel.get(vessel.id);
    if (berthId === undefined) return -1;
    return berths.findIndex((b) => b.id === berthId);
  });
  return { order, berth };
}

function orderCrossover(
  a: number[],
  b: number[],
  rand: () => number,
): number[] {
  const n = a.length;
  if (n < 2) return a.slice();
  let cut1 = Math.floor(rand() * n);
  let cut2 = Math.floor(rand() * n);
  if (cut1 > cut2) [cut1, cut2] = [cut2, cut1];
  const child: Array<number | null> = new Array(n).fill(null);
  const segment = new Set<number>();
  for (let i = cut1; i <= cut2; i++) {
    child[i] = a[i];
    segment.add(a[i]);
  }
  // Fill the rest with b's order, skipping genes already in the segment.
  let write = (cut2 + 1) % n;
  for (let k = 0; k < n; k++) {
    const gene = b[(cut2 + 1 + k) % n];
    if (segment.has(gene)) continue;
    child[write] = gene;
    write = (write + 1) % n;
  }
  return child as number[];
}

function tournament(
  population: Chromosome[],
  fitnesses: number[],
  rand: () => number,
): Chromosome {
  let bestIdx = Math.floor(rand() * population.length);
  for (let k = 1; k < TOURNAMENT_SIZE; k++) {
    const idx = Math.floor(rand() * population.length);
    if (fitnesses[idx] < fitnesses[bestIdx]) bestIdx = idx;
  }
  return population[bestIdx];
}

/**
 * Genetic-algorithm berth planner. Returns the best plan found across all
 * generations. Deterministic for a fixed seed.
 */
export function planGA(
  vessels: Vessel[],
  berths: Berth[],
  opts: PlanOptions = {},
): BerthPlan {
  const seed = opts.seed ?? DEFAULT_SEED;
  assertPlanningInputs(vessels, berths);
  if (vessels.length === 0 || berths.length === 0) {
    return sequencesToPlan(new Map(), vessels, { tidesEnabled: opts.tidesEnabled ?? false });
  }

  const rand = mulberry32(seed + 104729);
  let population: Chromosome[] = [greedyChromosome(vessels, berths, opts)];
  while (population.length < POPULATION) {
    population.push(randomChromosome(vessels, berths, rand));
  }

  let fitnesses = population.map((c) => fitness(c, vessels, berths, opts));
  let bestFitness = Math.min(...fitnesses);
  let best = population[fitnesses.indexOf(bestFitness)];

  for (let generation = 0; generation < GENERATIONS; generation++) {
    // Elites survive verbatim.
    const ranked = population
      .map((c, i) => ({ c, f: fitnesses[i] }))
      .sort((x, y) => x.f - y.f);
    const next: Chromosome[] = ranked.slice(0, ELITE_COUNT).map((x) => ({
      order: x.c.order.slice(),
      berth: x.c.berth.slice(),
    }));

    while (next.length < POPULATION) {
      const parentA = tournament(population, fitnesses, rand);
      const parentB = tournament(population, fitnesses, rand);
      let childOrder: number[];
      let childBerth: number[];
      if (rand() < CROSSOVER_RATE) {
        childOrder = orderCrossover(parentA.order, parentB.order, rand);
        // Uniform crossover on the berth vector (both parents feasible).
        childBerth = parentA.berth.map((gene, i) =>
          rand() < 0.5 ? gene : parentB.berth[i],
        );
      } else {
        childOrder = parentA.order.slice();
        childBerth = parentA.berth.slice();
      }
      // Swap mutation on the permutation.
      if (rand() < SWAP_MUTATION_RATE && childOrder.length >= 2) {
        const i = Math.floor(rand() * childOrder.length);
        let j = Math.floor(rand() * childOrder.length);
        if (j === i) j = (j + 1) % childOrder.length;
        [childOrder[i], childOrder[j]] = [childOrder[j], childOrder[i]];
      }
      // Random feasible-berth reassignment for one vessel.
      if (rand() < BERTH_MUTATION_RATE && vessels.length > 0) {
        const vi = Math.floor(rand() * vessels.length);
        const feasible = feasibleBerths(vessels[vi], berths);
        if (feasible.length > 0) {
          childBerth[vi] = feasible[Math.floor(rand() * feasible.length)];
        }
      }
      next.push({ order: childOrder, berth: childBerth });
    }

    population = next;
    fitnesses = population.map((c) => fitness(c, vessels, berths, opts));
    const genBestFitness = Math.min(...fitnesses);
    if (genBestFitness < bestFitness) {
      bestFitness = genBestFitness;
      best = population[fitnesses.indexOf(genBestFitness)];
    }
  }

  return decode(best, vessels, berths, opts);
}
