// Appointment detail — all fields, status timeline (from audit events),
// gate-verification history, and legal status transitions.

import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { getAppointment } from "@/lib/appointments";
import {
  Card,
  EmptyState,
  StatusBadge,
  OutcomeBadge,
  SyntheticTag,
  formatDateTime,
} from "@/components/ui";
import { TransitionButtons } from "./transition-buttons";
import { VerificationOutcome } from "@/contracts";

interface TimelineEvent {
  id: string;
  actorId: string;
  action: string;
  detailJson: string;
  createdAt: string;
}

interface Verification {
  id: string;
  plateRead: string | null;
  containerRead: string | null;
  confidence: number | null;
  outcome: string;
  reason: string;
  verifiedBy: string;
  createdAt: string;
}

export default async function AppointmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getDb();
  const appt = getAppointment(db, id);
  if (!appt) notFound();

  const timeline = db
    .prepare(
      `SELECT id, actor_id AS actorId, action, detail_json AS detailJson,
              created_at AS createdAt
       FROM audit_events
       WHERE entity = 'appointment' AND entity_id = ?
       ORDER BY created_at, rowid`
    )
    .all(id) as unknown as TimelineEvent[];

  const verifications = db
    .prepare(
      `SELECT id, plate_read AS plateRead, container_read AS containerRead,
              confidence, outcome, reason, verified_by AS verifiedBy,
              created_at AS createdAt
       FROM gate_verification_events
       WHERE appointment_id = ?
       ORDER BY created_at DESC`
    )
    .all(id) as unknown as Verification[];

  const clean = (v: string | null) => v?.replace("[SYNTHETIC DEMO DATA] ", "") ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/appointments" className="text-sm text-accent hover:underline">
            ← Appointments
          </Link>
          <h1 className="mt-1 font-mono text-xl font-bold text-ink">{appt.truckPlate}</h1>
        </div>
        <div className="flex items-center gap-3">
          <SyntheticTag />
          <StatusBadge status={appt.status} />
        </div>
      </div>

      <Card title="Appointment fields">
        <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Truck plate</dt>
            <dd className="font-mono text-ink">{appt.truckPlate}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Container</dt>
            <dd className="font-mono text-ink">{appt.containerNo ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Driver</dt>
            <dd className="text-ink">{clean(appt.driverName) ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Scheduled (UTC)</dt>
            <dd className="text-ink">{formatDateTime(appt.scheduledAt)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Created by</dt>
            <dd className="font-mono text-xs text-muted">{appt.createdBy}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Last updated</dt>
            <dd className="text-muted">{formatDateTime(appt.updatedAt)}</dd>
          </div>
        </dl>
      </Card>

      <Card title="Change status">
        <TransitionButtons appointmentId={appt.id} current={appt.status} />
      </Card>

      <Card title="Status timeline">
        {timeline.length === 0 ? (
          <EmptyState title="No timeline events" />
        ) : (
          <ol className="space-y-2">
            {timeline.map((e) => (
              <li key={e.id} className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
                <span className="text-muted">{formatDateTime(e.createdAt)}</span>
                <span className="font-medium text-ink">{e.action}</span>
                <span className="font-mono text-xs text-muted">{e.actorId}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card title="Gate verification history (simulated)">
        {verifications.length === 0 ? (
          <EmptyState
            title="No scans for this appointment"
            hint="Submit a simulated scan from the GateWatch page."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                  <th scope="col" className="py-2 pr-4 font-medium">Time</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Outcome</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Reason</th>
                  <th scope="col" className="py-2 font-medium">Verified by</th>
                </tr>
              </thead>
              <tbody>
                {verifications.map((v) => {
                  const o = VerificationOutcome.safeParse(v.outcome);
                  return (
                    <tr key={v.id} className="border-b border-line last:border-0 align-top">
                      <td className="py-2 pr-4 text-muted">{formatDateTime(v.createdAt)}</td>
                      <td className="py-2 pr-4">
                        {o.success ? (
                          <OutcomeBadge outcome={o.data} />
                        ) : (
                          <span className="text-muted">{v.outcome}</span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-ink">{v.reason}</td>
                      <td className="py-2 font-mono text-xs text-muted">{v.verifiedBy}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
