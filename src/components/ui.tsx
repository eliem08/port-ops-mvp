// Shared, server-safe UI primitives for the demo shell.
// Restrained enterprise style: flat colors, borders, no gradients.

import type { AppointmentStatus, VerificationOutcome } from "@/contracts";

const STATUS_STYLES: Record<AppointmentStatus, string> = {
  requested: "bg-slate2/10 text-slate2 border-slate2/30",
  confirmed: "bg-accent/10 text-accent border-accent/30",
  "checked-in": "bg-accent/20 text-ink border-accent/40",
  completed: "bg-ok/10 text-ok border-ok/30",
  cancelled: "bg-danger/10 text-danger border-danger/30",
  "no-show": "bg-warn/10 text-warn border-warn/30",
};

export function StatusBadge({ status }: { status: AppointmentStatus }) {
  return (
    <span
      className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

const OUTCOME_STYLES: Record<VerificationOutcome, string> = {
  "auto-accept": "bg-ok/10 text-ok border-ok/30",
  "human-review": "bg-warn/10 text-warn border-warn/30",
  "scan-failed": "bg-danger/10 text-danger border-danger/30",
};

const OUTCOME_LABELS: Record<VerificationOutcome, string> = {
  "auto-accept": "Auto-accept",
  "human-review": "Human review",
  "scan-failed": "Scan failed",
};

export function OutcomeBadge({ outcome }: { outcome: VerificationOutcome }) {
  return (
    <span
      className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${OUTCOME_STYLES[outcome]}`}
    >
      {OUTCOME_LABELS[outcome]}
    </span>
  );
}

/** Small tag marking any metric/record as synthetic demo data. */
export function SyntheticTag() {
  return (
    <span className="inline-block rounded border border-warn/40 bg-warn/10 px-2 py-0.5 text-xs font-medium text-warn">
      Synthetic demo data
    </span>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded border border-line bg-white px-6 py-10 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
    </div>
  );
}

export function Card({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded border border-line bg-white">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {action}
      </div>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
