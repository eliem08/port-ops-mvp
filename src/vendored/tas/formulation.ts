/**
 * lib/formulation.ts
 *
 * The formal problem statement behind this demo, as structured data.
 *
 * The in-app Methodology page (/methodology) and the README render this
 * module — the formulation lives in exactly one place, so the docs cannot
 * drift from the code. The mathematics describes the model the optimizer
 * actually solves; the "Honest mapping" notes say where the demo simplifies
 * the real world.
 *
 * Problem class: this is a TRUCK APPOINTMENT SYSTEM (TAS) slot-allocation
 * problem — a single-day, multi-gate, time-slotted assignment problem with
 * preferred windows, per-gate service rates, and no-show uncertainty. In the
 * literature it sits in the family studied by Huynh & Walton (2008),
 * Phan & Kim (2015), Zehendner & Feillet (2014) and Chen et al. (2013).
 * Every citation below was verified to exist (journal, volume, pages, DOI);
 * no citation is invented.
 */

/** One verified literature citation. `doi`/`url` present only when verified. */
export interface Citation {
  authors: string;
  year: number;
  title: string;
  venue: string;
  doi?: string;
  url?: string;
  /** Why this paper matters for this demo. */
  relevance: string;
}

export const CITATIONS: Citation[] = [
  {
    authors: "Huynh, N.; Walton, C.M.",
    year: 2008,
    title: "Robust scheduling of truck arrivals at marine container terminals",
    venue: "Journal of Transportation Engineering, 134(8), 347–353",
    doi: "10.1061/(ASCE)0733-947X(2008)134:8(347)",
    url: "https://doi.org/10.1061/(ASCE)0733-947X(2008)134:8(347)",
    relevance:
      "The foundational TAS scheduling paper: simulation + mathematical model to schedule truck arrivals and cut turn times. Our baseline-vs-TAS simulation comparison follows its methodology.",
  },
  {
    authors: "Phan, M.-H.; Kim, K.H.",
    year: 2015,
    title:
      "Negotiating truck arrival times among trucking companies and a container terminal",
    venue:
      "Transportation Research Part E: Logistics and Transportation Review, 75, 132–144",
    doi: "10.1016/j.tre.2015.01.004",
    url: "https://doi.org/10.1016/j.tre.2015.01.004",
    relevance:
      "Decentralized negotiation model: carriers state preferred times, the terminal proposes smoothed appointments, and the two sides iterate. Our reschedule penalty is the same trade-off — carrier inconvenience vs system waiting.",
  },
  {
    authors: "Zehendner, E.; Feillet, D.",
    year: 2014,
    title:
      "Benefits of a truck appointment system on the service quality of inland transport modes at a multimodal container terminal",
    venue: "European Journal of Operational Research, 235(2), 461–469",
    url: "https://econpapers.repec.org/RePEc:eee:ejores:v:235:y:2014:i:2:p:461-469",
    relevance:
      "MILP + discrete-event simulation on real terminal data: TAS improves not just trucks but trains, barges and vessels. The paper that justifies pairing an optimizer with a simulator — the architecture this demo copies.",
  },
  {
    authors: "Chen, G.; Govindan, K.; Golias, M.M.",
    year: 2013,
    title:
      "Reducing truck emissions at container terminals: An emission-based bi-objective model for optimizing truck arrival pattern",
    venue: "Transportation Research Part E: Logistics and Transportation Review, 55, 3–22",
    doi: "10.1016/j.tre.2013.03.008",
    url: "https://doi.org/10.1016/j.tre.2013.03.008",
    relevance:
      "Bi-objective TAS: minimize truck waiting AND emissions simultaneously, solved as a Pareto frontier. The direct ancestor of our Pareto panel — waiting vs reschedules via epsilon-constraint/weight sweep.",
  },
  {
    authors: "Chen, G.; Govindan, K.; Yang, Z.",
    year: 2013,
    title:
      "Managing truck arrivals with time windows to alleviate gate congestion at container terminals",
    venue: "International Journal of Production Economics, 141, 179–188",
    doi: "10.1016/j.ijpe.2012.03.033",
    url: "https://doi.org/10.1016/j.ijpe.2012.03.033",
    relevance:
      "Time-window management as the congestion lever: shifting arrivals out of the peak by bounded amounts. Our replanning and pricing modules are applications of the same idea.",
  },
  {
    authors: "Giuliano, G.; O'Brien, T.",
    year: 2007,
    title:
      "Reducing port-related truck emissions: The terminal gate appointment system at the Ports of Los Angeles and Long Beach",
    venue:
      "Transportation Research Part D: Transport and Environment, 12, 460–473",
    relevance:
      "Early empirical evidence that gate appointments cut truck idling emissions. Motivates treating CO₂ as a first-class KPI, not a side effect.",
  },
  {
    authors: "Abdelmagid, A.M.; Gheith, M.S.; Eltawil, A.B.",
    year: 2022,
    title:
      "A comprehensive review of the truck appointment scheduling models and directions for future research",
    venue: "Transport Reviews, 42, 102–126",
    relevance:
      "The standard survey of the field: taxonomies of TAS models (deterministic/stochastic, single/multi-player) and open directions — stochastic planning and mechanism design among them.",
  },
];

/** One block of the formal problem statement. */
export interface FormulationBlock {
  heading: string;
  lines: string[];
}

export const FORMULATION: FormulationBlock[] = [
  {
    heading: "Sets",
    lines: [
      "I — set of truck booking requests, indexed by i ( |I| = n ).",
      "G = {0, 1, 2} — gates (Express, Standard, Inspection).",
      "S = {0, …, 31} — 30-minute slots in the operating day, 06:00–22:00.",
      "K — no-show scenarios (stochastic planning only), indexed by k.",
    ],
  },
  {
    heading: "Parameters",
    lines: [
      "W_i = [a_i, b_i] — preferred window of request i (minutes since midnight).",
      "c_{g,s} — capacity of gate g in slot s: floor(30 / serviceMin_g), i.e. 7 / 6 / 3.",
      "r_{i,g,s} ∈ {0,1} — 1 if slot s at gate g lies outside W_i (reschedule indicator).",
      "m_{i,g} ∈ {0,1} — 1 if gate g is not request i's terminal gate (terminal-mismatch indicator).",
      "τ_g — service time per truck at gate g (4 / 5 / 8 min).",
      "p_i ∈ [0.02, 0.85] — modelled no-show probability of request i (heuristic, see lib/predictor.ts).",
      "w_wait, w_resched, w_term, w_peak — objective weights (defaults 0.5, 3, 2, 10).",
    ],
  },
  {
    heading: "Decision variables",
    lines: [
      "x_{i,g,s} ∈ {0,1} — 1 if request i is assigned to gate g, slot s.",
      "L_{g,s} = Σ_i x_{i,g,s} — load (trucks) at gate g, slot s.",
      "M = max_{g,s} L_{g,s} — peak slot load across the day.",
    ],
  },
  {
    heading: "Objective (deterministic core)",
    lines: [
      "min  w_peak · M  +  w_resched · Σ_{i,g,s} r_{i,g,s}·x_{i,g,s}  +  w_term · Σ_{i,g,s} m_{i,g}·x_{i,g,s}  +  w_wait · Σ_{g,s} L_{g,s}·(L_{g,s} − 1)·τ_g / 2",
      "The wait term is the closed form of the in-slot queue: with L trucks sharing a slot and service τ_g, the modelled waits are 0, τ_g/2, 2τ_g/2, …, (L−1)·τ_g/2 — summed, L·(L−1)·τ_g/2. (The /2 reflects the demo's convention that a truck's expected wait is half the queue ahead of it, i.e. arrivals spread uniformly across the slot.)",
      "CO₂ is a derived KPI, not an objective term: idle fuel 2.5 L/h × 2.68 kg CO₂/L × total wait. Because it is a linear function of total wait, waiting-vs-CO₂ is a degenerate pair — the Pareto panel therefore trades waiting against reschedules, the two genuinely conflicting objectives.",
    ],
  },
  {
    heading: "Constraints",
    lines: [
      "(C1) Assignment — every request gets exactly one slot: Σ_{g,s} x_{i,g,s} = 1 for all i.",
      "(C2) Capacity — no slot exceeds its gate capacity: L_{g,s} ≤ c_{g,s} for all g, s. " +
        "QUALIFICATION: C2 holds whenever total demand fits total capacity. Under extreme overload " +
        "(demand > capacity, or adversarial blocked input) the optimizer's documented fallback spills " +
        "trucks onto the least-loaded slots rather than dropping them, so C2 can be violated — " +
        "lib/optimizer.ts findOverloads() reports exactly which slots overflow, and /api/optimize " +
        "surfaces the count as summary.overflowSlots.",
      "(C3) Time feasibility — assignments use slots within the operating day (and never before 'now' in replanning).",
      "(C4) Integrality — x_{i,g,s} ∈ {0,1}. (The demo never splits a truck across slots.)",
    ],
  },
  {
    heading: "Complexity",
    lines: [
      "The problem is NP-hard in general (assignment with a convex load-dependent cost and a max-load term). The demo therefore offers a ladder of methods, each honest about its guarantee:",
      "• Greedy + local search — fast, no optimality guarantee.",
      "• Simulated annealing — best-seen kept, never worse than greedy, no optimality guarantee.",
      "• Branch-and-bound (exact) — PROVES optimality for n ≤ 12, with a node budget; reports 'not proven' if the budget is exhausted.",
      "• Stochastic (SAA) — optimizes expected cost over sampled no-show scenarios; the candidate-set search is heuristic, the evaluation is exact over the sampled scenarios.",
      "• Pareto — weight-sweep + non-domination filter; points are SA-refined approximations of the true frontier, not proven Pareto-optimal.",
    ],
  },
  {
    heading: "Honest mapping — what the model is NOT",
    lines: [
      "• Days are independent: no cross-day carryover of trucks or yard inventory.",
      "• No yard, crane, customs, or vessel dynamics — the gate is the only modelled bottleneck.",
      "• No-show probabilities are a hand-tuned heuristic (priors, not fitted parameters). Scenario planning inherits that uncertainty.",
      "• Wait is a within-slot queueing approximation, not a microsimulation of gate physics.",
      "• Prices in the congestion-pricing module are illustrative; willingness-to-pay is synthetic. Nothing here is a claim about real Casablanca port tariffs.",
      "• All demand is synthetic, seeded and deterministic. Results demonstrate the method, not the port.",
    ],
  },
];

/** Method cards: algorithm, guarantee, complexity, where it lives. */
export interface MethodCard {
  name: string;
  guarantee: string;
  complexity: string;
  file: string;
}

export const METHODS: MethodCard[] = [
  {
    name: "Greedy + local search",
    guarantee: "Feasible; no optimality guarantee.",
    complexity: "O(n · G · S + 250 local moves)",
    file: "lib/optimizer.ts",
  },
  {
    name: "Simulated annealing",
    guarantee: "Never worse than greedy (best-seen kept); no optimality guarantee.",
    complexity: "O(2,500 neighbour moves)",
    file: "lib/annealer.ts",
  },
  {
    name: "Branch-and-bound (exact)",
    guarantee: "PROVES optimality for n ≤ 12, or reports 'not proven' on node-budget exhaustion.",
    complexity: "Worst case O((G·S)^n); pruned by a valid lower bound",
    file: "lib/exact.ts",
  },
  {
    name: "Stochastic SAA + chance constraint",
    guarantee: "Exact evaluation over sampled scenarios; candidate-set search is heuristic.",
    complexity: "O(candidates × scenarios × n)",
    file: "lib/stochastic.ts",
  },
  {
    name: "Pareto frontier (weight sweep)",
    guarantee: "Returned points are mutually non-dominated; frontier is SA-refined, not proven.",
    complexity: "O(|Λ| × SA cost), |Λ| = 11 by default",
    file: "lib/pareto.ts",
  },
  {
    name: "Batch-means CI + Little's Law",
    guarantee: "Statistical consistency check on simulator bookkeeping; not a physics validation.",
    complexity: "O(steps) instrumentation on one simulation run",
    file: "lib/statistics.ts",
  },
  {
    name: "Congestion pricing (mechanism)",
    guarantee: "Illustrative demand-shaping mechanism; no equilibrium claim.",
    complexity: "O(n · slots) re-centring + one re-optimization",
    file: "lib/pricing.ts",
  },
];
