// Review queue — pending human-review scans. Decision buttons are shown
// only to supervisor+ roles; the server action enforces the role regardless.

import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { getSession } from "@/lib/auth";
import { Card, EmptyState, OutcomeBadge, SyntheticTag, formatDateTime } from "@/components/ui";
import { ReviewDecisionButtons } from "./review-buttons";
import { VerificationOutcome } from "@/contracts";

interface PendingReview {
  id: string;
  eventId: string;
  createdAt: string;
  plateRead: string | null;
  containerRead: string | null;
  confidence: number | null;
  outcome: string;
  reason: string;
  appointmentId: string;
  truckPlate: string;
  appointmentStatus: string;
}

function canDecide(role: string | undefined): boolean {
  return role === "supervisor" || role === "administrator";
}

export default async function ReviewsPage() {
  const session = await getSession();
  const db = getDb();

  const pending = db
    .prepare(
      `SELECT r.id, r.event_id AS eventId, r.created_at AS createdAt,
              e.plate_read AS plateRead, e.container_read AS containerRead,
              e.confidence, e.outcome, e.reason, e.appointment_id AS appointmentId,
              a.truck_plate AS truckPlate, a.status AS appointmentStatus
       FROM review_items r
       JOIN gate_verification_events e ON e.id = r.event_id
       JOIN appointments a ON a.id = e.appointment_id
       WHERE r.status = 'pending'
       ORDER BY r.created_at`
    )
    .all() as unknown as PendingReview[];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/gate" className="text-sm text-accent hover:underline">
            ← GateWatch
          </Link>
          <h1 className="mt-1 text-xl font-bold text-ink">Human review queue</h1>
          <p className="mt-1 text-sm text-muted">
            Scans that could not be auto-verified. All scans are simulated.
          </p>
        </div>
        <SyntheticTag />
      </div>

      <Card title={`Pending reviews (${pending.length})`}>
        {pending.length === 0 ? (
          <EmptyState
            title="Queue is empty"
            hint="Low-confidence or mismatched simulated scans will appear here."
          />
        ) : (
          <div className="space-y-4">
            {pending.map((r) => {
              const o = VerificationOutcome.safeParse(r.outcome);
              return (
                <div key={r.id} className="rounded border border-line bg-paper px-4 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-mono text-sm font-medium text-ink">
                        {r.truckPlate}
                        <span className="ml-2 text-xs text-muted">
                          {r.appointmentStatus}
                        </span>
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        Queued {formatDateTime(r.createdAt)}
                      </p>
                    </div>
                    {o.success && <OutcomeBadge outcome={o.data} />}
                  </div>
                  <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-muted">
                        Plate read
                      </dt>
                      <dd className="font-mono text-ink">{r.plateRead ?? "— (no read)"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-muted">
                        Container read
                      </dt>
                      <dd className="font-mono text-ink">{r.containerRead ?? "— (no read)"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-muted">
                        Confidence
                      </dt>
                      <dd className="text-ink">
                        {r.confidence === null ? "— (missing)" : r.confidence}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-muted">
                        Reason
                      </dt>
                      <dd className="text-ink">{r.reason}</dd>
                    </div>
                  </dl>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <Link
                      href={`/appointments/${r.appointmentId}`}
                      className="text-sm font-medium text-accent hover:underline"
                    >
                      View appointment
                    </Link>
                  </div>
                  <div className="mt-3 border-t border-line pt-3">
                    {canDecide(session?.role) ? (
                      <ReviewDecisionButtons reviewId={r.id} />
                    ) : (
                      <p className="text-sm text-muted">
                        Approve/reject requires the supervisor role. You are
                        signed in as {session?.role ?? "unknown"}.
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
