// Appointments list — server component, direct DB reads via the shared
// appointment domain library. KPIs computed from the listed records.

import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { listAppointments, type AppointmentDTO } from "@/lib/appointments";
import { AppointmentStatus, type AppointmentStatus as StatusT } from "@/contracts";
import { Card, EmptyState, StatusBadge, formatDateTime } from "@/components/ui";
import { SyntheticTag } from "@/components/synthetic-tag";
import { StatusFilter } from "./status-filter";

const STATUS_ORDER: StatusT[] = [
  "requested",
  "confirmed",
  "checked-in",
  "completed",
  "cancelled",
  "no-show",
];

function kpis(records: AppointmentDTO[]) {
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<
    StatusT,
    number
  >;
  for (const r of records) counts[r.status] += 1;
  return counts;
}

export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const params = await searchParams;
  const filter = AppointmentStatus.safeParse(params.status);
  const statusFilter = filter.success ? filter.data : undefined;
  const records = listAppointments(getDb(), statusFilter);
  const counts = kpis(listAppointments(getDb()));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Appointments</h1>
          <p className="mt-1 text-sm text-muted">
            Truck appointment slots.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <SyntheticTag />
          {/* File download from an API route, not page navigation — <Link> would try client-side routing. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            href="/api/appointments/export"
            className="rounded border border-line bg-white px-3 py-2 text-sm text-ink hover:bg-paper"
          >
            Export CSV
          </a>
          <Link
            href="/appointments/new"
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            New appointment
          </Link>
        </div>
      </div>

      {/* KPIs from the listed records */}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {STATUS_ORDER.map((s) => (
          <div key={s} className="rounded border border-line bg-white px-3 py-3">
            <dt className="mb-1">
              <StatusBadge status={s} />
            </dt>
            <dd className="text-2xl font-bold text-ink">{counts[s]}</dd>
          </div>
        ))}
      </dl>

      <Card
        title="Appointment records"
        action={<StatusFilter current={statusFilter} options={STATUS_ORDER} />}
      >
        {records.length === 0 ? (
          <EmptyState
            title="No appointments found"
            hint={
              statusFilter
                ? `No appointments with status '${statusFilter}'.`
                : "Create one with the New appointment button."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                  <th scope="col" className="py-2 pr-4 font-medium">Plate</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Container</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Driver</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Scheduled (UTC)</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Status</th>
                  <th scope="col" className="py-2 font-medium">
                    <span className="sr-only">Detail</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-0 hover:bg-paper">
                    <td className="py-2 pr-4 font-mono text-ink">{r.truckPlate}</td>
                    <td className="py-2 pr-4 font-mono text-muted">{r.containerNo ?? "—"}</td>
                    <td className="py-2 pr-4 text-ink">
                      {r.driverName?.replace("[SYNTHETIC DEMO DATA] ", "") ?? "—"}
                    </td>
                    <td className="py-2 pr-4 text-muted">{formatDateTime(r.scheduledAt)}</td>
                    <td className="py-2 pr-4">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="py-2">
                      <Link
                        href={`/appointments/${r.id}`}
                        className="font-medium text-accent hover:underline"
                      >
                        Detail
                      </Link>
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
