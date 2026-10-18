// Solver/optimality banner for plan runs. The word "optimal" appears here
// ONLY when provenOptimal is true — heuristic runs are always labelled as
// heuristic, never optimal.

import type { BerthPlanDTO } from "@/lib/planning";
import { SOLVER_LABELS } from "@/lib/planning";

export function OptimalityBanner({ run }: { run: BerthPlanDTO }) {
  if (run.provenOptimal) {
    return (
      <div
        role="status"
        className="rounded border border-ok/40 bg-ok/10 px-4 py-3"
      >
        <p className="text-sm font-bold text-ok">
          PROVEN OPTIMAL — exact solver, {run.vesselCount} vessel
          {run.vesselCount === 1 ? "" : "s"}
        </p>
        <p className="mt-1 text-xs text-muted">
          Branch and bound exhausted the search tree below the node cap.
        </p>
      </div>
    );
  }
  return (
    <div role="status" className="rounded border border-warn/40 bg-warn/10 px-4 py-3">
      <p className="text-sm font-bold text-warn">
        HEURISTIC — {SOLVER_LABELS[run.solverUsed]} (result quality not certified)
      </p>
      {run.exactUnavailableReason && (
        <p className="mt-1 text-xs text-muted">{run.exactUnavailableReason}</p>
      )}
      {run.solverRequested !== run.solverUsed && !run.exactUnavailableReason && (
        <p className="mt-1 text-xs text-muted">
          Requested solver: {SOLVER_LABELS[run.solverRequested]}.
        </p>
      )}
    </div>
  );
}

/** Compact badge for the runs list. Never says "optimal" unless proven. */
export function OptimalityBadge({ run }: { run: BerthPlanDTO }) {
  if (run.provenOptimal) {
    return (
      <span className="inline-block rounded border border-ok/30 bg-ok/10 px-2 py-0.5 text-xs font-medium text-ok">
        Proven optimal
      </span>
    );
  }
  return (
    <span className="inline-block rounded border border-warn/30 bg-warn/10 px-2 py-0.5 text-xs font-medium text-warn">
      Heuristic
    </span>
  );
}
