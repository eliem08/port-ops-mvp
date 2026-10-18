// BerthWise planning — client-safe data (no node:, no next/headers).
// Imported by the "New plan" client form. The solver/domain logic lives in
// ./planning.ts (server-only) and re-exports these.

import type { SolverChoice, VesselInput, BerthInput } from "@/contracts";

export const SOLVER_LABELS: Record<SolverChoice, string> = {
  exact: "exact (branch and bound)",
  greedy: "greedy (first-come-first-served)",
  annealing: "simulated annealing",
  tabu: "tabu search",
  genetic: "genetic algorithm",
};

export interface DemoPlanningScenario {
  name: string;
  description: string;
  suggestedSolver: SolverChoice;
  vessels: VesselInput[];
  berths: BerthInput[];
}

/**
 * Loadable demo presets for the "New plan" form. These are offered as
 * starting points only — plan runs are created explicitly by the user.
 * Every value is synthetic.
 */
export const DEMO_PLANNING_SCENARIOS: DemoPlanningScenario[] = [
  {
    name: "SYNTHETIC — Morning container rush",
    description:
      "6 container vessels (one grain) arriving through the morning across 3 quays. Small enough for the exact solver — demonstrates a proven-optimal plan.",
    suggestedSolver: "exact",
    berths: [
      { name: "SYN Quay A", lengthM: 350, maxDraftM: 15, grainCapable: true },
      { name: "SYN Quay B", lengthM: 300, maxDraftM: 13, grainCapable: false },
      { name: "SYN Quay C", lengthM: 250, maxDraftM: 11, grainCapable: false },
    ],
    vessels: [
      { name: "SYN Altair", lengthM: 280, draftM: 12, eta: "2026-10-20T06:00:00Z", etd: "2026-10-20T16:00:00Z", grainCapable: false },
      { name: "SYN Borealis", lengthM: 220, draftM: 10, eta: "2026-10-20T07:30:00Z", etd: "2026-10-20T17:30:00Z", grainCapable: false },
      { name: "SYN Ceres", lengthM: 260, draftM: 12.5, eta: "2026-10-20T08:00:00Z", etd: "2026-10-20T20:00:00Z", grainCapable: true },
      { name: "SYN Deneb", lengthM: 330, draftM: 13.5, eta: "2026-10-20T09:00:00Z", etd: "2026-10-20T21:00:00Z", grainCapable: false },
      { name: "SYN Eridanus", lengthM: 190, draftM: 9, eta: "2026-10-20T10:30:00Z", etd: "2026-10-20T18:30:00Z", grainCapable: false },
      { name: "SYN Fornax", lengthM: 240, draftM: 10.5, eta: "2026-10-20T12:00:00Z", etd: "2026-10-20T22:00:00Z", grainCapable: false },
    ],
  },
  {
    name: "SYNTHETIC — Grain and container week",
    description:
      "9 mixed vessels over two days across 4 quays. Above the exact solver's 8-vessel ceiling — requesting 'exact' here demonstrates the labelled heuristic fallback.",
    suggestedSolver: "annealing",
    berths: [
      { name: "SYN Quay A", lengthM: 350, maxDraftM: 15, grainCapable: true },
      { name: "SYN Quay B", lengthM: 300, maxDraftM: 13, grainCapable: false },
      { name: "SYN Quay C", lengthM: 250, maxDraftM: 11, grainCapable: false },
      { name: "SYN Quay D", lengthM: 200, maxDraftM: 9.5, grainCapable: true },
    ],
    vessels: [
      { name: "SYN Altair", lengthM: 280, draftM: 12, eta: "2026-10-20T06:00:00Z", etd: "2026-10-20T18:00:00Z", grainCapable: false },
      { name: "SYN Borealis", lengthM: 220, draftM: 10, eta: "2026-10-20T08:00:00Z", etd: "2026-10-20T20:00:00Z", grainCapable: false },
      { name: "SYN Ceres", lengthM: 260, draftM: 12.5, eta: "2026-10-20T10:00:00Z", etd: "2026-10-21T00:00:00Z", grainCapable: true },
      { name: "SYN Deneb", lengthM: 330, draftM: 13.5, eta: "2026-10-20T12:00:00Z", etd: "2026-10-21T02:00:00Z", grainCapable: false },
      { name: "SYN Eridanus", lengthM: 190, draftM: 9, eta: "2026-10-20T14:00:00Z", etd: "2026-10-20T22:00:00Z", grainCapable: false },
      { name: "SYN Fornax", lengthM: 240, draftM: 10.5, eta: "2026-10-20T16:00:00Z", etd: "2026-10-21T04:00:00Z", grainCapable: false },
      { name: "SYN Gemini", lengthM: 180, draftM: 8.5, eta: "2026-10-20T18:00:00Z", etd: "2026-10-21T06:00:00Z", grainCapable: true },
      { name: "SYN Hydra", lengthM: 300, draftM: 12, eta: "2026-10-20T20:00:00Z", etd: "2026-10-21T10:00:00Z", grainCapable: false },
      { name: "SYN Indus", lengthM: 210, draftM: 9.5, eta: "2026-10-20T22:00:00Z", etd: "2026-10-21T12:00:00Z", grainCapable: false },
    ],
  },
  {
    name: "SYNTHETIC — Tight draft, oversize visitor",
    description:
      "5 vessels, 3 quays. One 400 m vessel fits no berth (recorded as unassigned, not an error) and one deep-draft vessel fits only the deep quay.",
    suggestedSolver: "greedy",
    berths: [
      { name: "SYN Quay A", lengthM: 350, maxDraftM: 15, grainCapable: true },
      { name: "SYN Quay B", lengthM: 300, maxDraftM: 12, grainCapable: false },
      { name: "SYN Quay C", lengthM: 250, maxDraftM: 10, grainCapable: false },
    ],
    vessels: [
      { name: "SYN Altair", lengthM: 280, draftM: 11, eta: "2026-10-21T06:00:00Z", etd: "2026-10-21T16:00:00Z", grainCapable: false },
      { name: "SYN Leviathan", lengthM: 400, draftM: 14, eta: "2026-10-21T07:00:00Z", etd: "2026-10-21T19:00:00Z", grainCapable: false },
      { name: "SYN Ceres", lengthM: 260, draftM: 14.5, eta: "2026-10-21T08:00:00Z", etd: "2026-10-21T20:00:00Z", grainCapable: true },
      { name: "SYN Borealis", lengthM: 220, draftM: 9.5, eta: "2026-10-21T09:00:00Z", etd: "2026-10-21T17:00:00Z", grainCapable: false },
      { name: "SYN Eridanus", lengthM: 190, draftM: 8, eta: "2026-10-21T10:00:00Z", etd: "2026-10-21T18:00:00Z", grainCapable: false },
    ],
  },
];
