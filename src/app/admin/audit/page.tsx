// Audit trail viewer (administrator): filter, page through and export the
// append-only audit log. Filters are plain GET parameters so a filtered view
// can be bookmarked or shared with an auditor.

import Link from "next/link";
import { AuditFilter, distinctAuditActions, queryAudit } from "@/lib/audit-query";
import { auditActionLabel } from "@/lib/dashboard";
import { getDb } from "@/lib/db/client";
import { Card, EmptyState, formatDateTime } from "@/components/ui";

const INPUT = "mt-1 block w-full rounded border border-line bg-white px-2 py-1.5 text-sm";

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = Object.fromEntries(
    Object.entries(await searchParams).filter(([, v]) => typeof v === "string" && v !== "")
  ) as Record<string, string>;
  const parsed = AuditFilter.safeParse(raw);
  const filter = parsed.success ? parsed.data : AuditFilter.parse({});
  const db = getDb();
  const { rows, total, pages } = queryAudit(db, filter);
  const actions = distinctAuditActions(db);
  const qs = (overrides: Record<string, string | number>) =>
    new URLSearchParams(
      Object.entries({ ...raw, ...overrides }).map(([k, v]) => [k, String(v)])
    ).toString();
  const exportQs = new URLSearchParams(Object.entries(raw).filter(([k]) => k !== "page")).toString();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Audit trail</h1>
          <p className="text-sm text-muted">{total} event(s). Append-only — no event can be edited or deleted.</p>
        </div>
        <a
          href={`/api/admin/audit/export${exportQs ? `?${exportQs}` : ""}`}
          className="rounded border border-line bg-white px-3 py-1.5 text-sm text-ink hover:bg-paper"
        >
          Export CSV
        </a>
      </div>

      <Card title="Filter">
        <form className="grid gap-3 sm:grid-cols-5" method="get">
          <label className="text-xs font-medium text-muted">
            Action
            <select name="action" defaultValue={filter.action ?? ""} className={INPUT}>
              <option value="">All</option>
              {actions.map((a) => (
                <option key={a} value={a}>
                  {auditActionLabel(a)} ({a})
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-muted">
            Actor (id, email or name)
            <input name="actor" defaultValue={filter.actor ?? ""} className={INPUT} />
          </label>
          <label className="text-xs font-medium text-muted">
            From
            <input type="date" name="from" defaultValue={filter.from ?? ""} className={INPUT} />
          </label>
          <label className="text-xs font-medium text-muted">
            To
            <input type="date" name="to" defaultValue={filter.to ?? ""} className={INPUT} />
          </label>
          <div className="flex items-end gap-2">
            <button type="submit" className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white">
              Apply
            </button>
            <Link href="/admin/audit" className="px-2 py-1.5 text-sm text-muted hover:underline">
              Reset
            </Link>
          </div>
        </form>
      </Card>

      <Card title={`Events — page ${filter.page} of ${pages}`}>
        {rows.length === 0 ? (
          <EmptyState title="No events match these filters." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-muted">
                <tr>
                  <th className="py-2 pr-3">When</th>
                  <th className="py-2 pr-3">Actor</th>
                  <th className="py-2 pr-3">Action</th>
                  <th className="py-2 pr-3">Entity</th>
                  <th className="py-2">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="whitespace-nowrap py-2 pr-3 text-xs text-muted">{formatDateTime(r.createdAt)}</td>
                    <td className="py-2 pr-3">
                      <span className="text-ink">{r.actorLabel ?? r.actorId}</span>
                    </td>
                    <td className="py-2 pr-3 text-ink">{auditActionLabel(r.action)}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-muted">
                      {r.entity}/{r.entityId.slice(0, 12)}
                    </td>
                    <td className="max-w-md break-all py-2 font-mono text-xs text-muted">{r.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <nav className="mt-4 flex gap-3 text-sm" aria-label="Pagination">
            {filter.page > 1 && <Link href={`/admin/audit?${qs({ page: filter.page - 1 })}`}>← Newer</Link>}
            {filter.page < pages && <Link href={`/admin/audit?${qs({ page: filter.page + 1 })}`}>Older →</Link>}
          </nav>
        )}
      </Card>
    </div>
  );
}
