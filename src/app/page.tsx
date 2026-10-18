// Dashboard — server component reading real DB state via the shared helper.
// Every metric is computed from the database; nothing is hardcoded.

import Link from "next/link";
import { getDashboardStats, auditActionLabel } from "@/lib/dashboard";
import { Card, EmptyState, StatusBadge, OutcomeBadge, SyntheticTag, formatDateTime } from "@/components/ui";
import type { AppointmentStatus, VerificationOutcome } from "@/contracts";

const STATUS_ORDER: AppointmentStatus[] = [
  "requested",
  "confirmed",
  "checked-in",
  "completed",
  "cancelled",
  "no-show",
];

const OUTCOME_ORDER: VerificationOutcome[] = ["auto-accept", "human-review", "scan-failed"];

export default function DashboardPage() {
  const stats = getDashboardStats();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Operations dashboard</h1>
          <p className="mt-1 text-sm text-muted">
            Live view of the demo database. All figures are synthetic.
          </p>
        </div>
        <SyntheticTag />
      </div>

      {/* Appointments by status — the real six statuses */}
      <Card
        title="Appointments by status"
        action={
          <Link href="/appointments" className="text-sm font-medium text-accent hover:underline">
            View all
          </Link>
        }
      >
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {STATUS_ORDER.map((s) => (
            <div key={s} className="rounded border border-line bg-paper px-3 py-3">
              <dt className="mb-1">
                <StatusBadge status={s} />
              </dt>
              <dd className="text-2xl font-bold text-ink">{stats.appointmentsByStatus[s]}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-muted">
          Total appointments: {stats.totalAppointments} (synthetic records)
        </p>
      </Card>

      {/* Verification outcomes + review queue */}
      <div className="grid gap-6 md:grid-cols-2">
        <Card
          title="Gate verification outcomes"
          action={
            <Link href="/gate" className="text-sm font-medium text-accent hover:underline">
              GateWatch
            </Link>
          }
        >
          {stats.totalVerifications === 0 ? (
            <EmptyState
              title="No scans yet"
              hint="Submit a simulated scan from the GateWatch page."
            />
          ) : (
            <dl className="grid grid-cols-3 gap-3">
              {OUTCOME_ORDER.map((o) => (
                <div key={o} className="rounded border border-line bg-paper px-3 py-3">
                  <dt className="mb-1">
                    <OutcomeBadge outcome={o} />
                  </dt>
                  <dd className="text-2xl font-bold text-ink">{stats.verificationsByOutcome[o]}</dd>
                </div>
              ))}
            </dl>
          )}
        </Card>

        <Card
          title="Human review queue"
          action={
            <Link href="/gate/reviews" className="text-sm font-medium text-accent hover:underline">
              Review queue
            </Link>
          }
        >
          <div className="rounded border border-line bg-paper px-3 py-3">
            <p className="text-sm text-muted">Pending reviews</p>
            <p className="text-2xl font-bold text-ink">{stats.pendingReviews}</p>
          </div>
          <p className="mt-3 text-xs text-muted">
            Scans routed to humans are never auto-accepted.
          </p>
        </Card>
      </div>

      {/* Recent audit events */}
      <Card title="Recent audit events">
        {stats.recentAudit.length === 0 ? (
          <EmptyState title="No audit events yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                  <th scope="col" className="py-2 pr-4 font-medium">Time</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Actor</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Action</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Entity</th>
                  <th scope="col" className="py-2 font-medium">Entity ID</th>
                </tr>
              </thead>
              <tbody>
                {stats.recentAudit.map((e) => (
                  <tr key={e.id} className="border-b border-line last:border-0">
                    <td className="py-2 pr-4 text-muted">{formatDateTime(e.createdAt)}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-ink">{e.actorId}</td>
                    <td className="py-2 pr-4 text-ink">{auditActionLabel(e.action)}</td>
                    <td className="py-2 pr-4 text-muted">{e.entity}</td>
                    <td className="py-2 font-mono text-xs text-muted">
                      {e.entityId.slice(0, 8)}…
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
