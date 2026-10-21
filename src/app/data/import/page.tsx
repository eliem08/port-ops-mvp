// Data import (supervisor or administrator): load truck appointments from a
// terminal / TAS CSV export. Validate first (dry run), then commit.

import { getDb } from "@/lib/db/client";
import { listImportBatches } from "@/lib/importer";
import { Card, EmptyState, formatDateTime } from "@/components/ui";
import { ImportPanel } from "./import-panel";

export default function ImportPage() {
  const batches = listImportBatches(getDb());
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink">Import data</h1>
        <p className="text-sm text-muted">
          Load truck appointments from your terminal or appointment-system export. Files are validated row by row before
          anything is written; re-sending the same file never creates duplicates.
        </p>
      </div>

      <Card title="Appointments CSV" action={<a className="text-sm text-accent hover:underline" href="/api/imports/template">Download template</a>}>
        <ImportPanel />
      </Card>

      <Card title="Import history">
        {batches.length === 0 ? (
          <EmptyState title="No imports yet." />
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-muted">
              <tr>
                <th className="py-2 pr-3">When</th>
                <th className="py-2 pr-3">File</th>
                <th className="py-2 pr-3">Rows</th>
                <th className="py-2 pr-3">Created</th>
                <th className="py-2 pr-3">Already present</th>
                <th className="py-2">By</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {batches.map((b) => (
                <tr key={b.id}>
                  <td className="py-2 pr-3 text-xs text-muted">{formatDateTime(b.createdAt)}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{b.filename ?? "—"}</td>
                  <td className="py-2 pr-3">{b.rows}</td>
                  <td className="py-2 pr-3 text-accent">{b.created}</td>
                  <td className="py-2 pr-3 text-muted">{b.skipped}</td>
                  <td className="py-2">{b.createdBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
