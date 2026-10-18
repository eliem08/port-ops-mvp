// GateWatch — simulated scan submission. The scan is always synthetic.

import { getDb } from "@/lib/db/client";
import { listAppointments } from "@/lib/appointments";
import { Card, SyntheticTag } from "@/components/ui";
import { ScanForm } from "./scan-form";

export default function GatePage() {
  const appointments = listAppointments(getDb());

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-ink">GateWatch</h1>
          <p className="mt-1 text-sm text-muted">
            Simulated gate-scan verification. Last scan events are synthetic.
          </p>
        </div>
        <SyntheticTag />
      </div>
      <Card title="Submit a scan">
        {appointments.length === 0 ? (
          <p className="text-sm text-muted">
            No appointments to verify against. Create one first.
          </p>
        ) : (
          <ScanForm appointments={appointments} />
        )}
      </Card>
    </div>
  );
}

