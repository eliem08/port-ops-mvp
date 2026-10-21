"use client";

// Pick a CSV → dry run (validation report) → commit.

import { useState } from "react";
import type { ImportReport } from "@/lib/importer";

export function ImportPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(dryRun: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ dryRun: dryRun ? "1" : "0", filename: file.name });
      const res = await fetch(`/api/imports/appointments?${params}`, {
        method: "POST",
        headers: { "content-type": "text/csv" },
        body: await file.text(),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message ?? `Import failed (${res.status})`);
      setReport(data);
      if (!dryRun) setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        Columns: <code className="font-mono">truck_plate</code>*, <code className="font-mono">scheduled_at</code>* (ISO UTC, e.g.
        2026-11-02T08:30:00Z), <code className="font-mono">container_no</code> (ISO 6346), <code className="font-mono">driver_name</code>,{" "}
        <code className="font-mono">status</code> (requested | confirmed), <code className="font-mono">external_ref</code> (your system&apos;s id —
        makes re-imports safe). Comma or semicolon separated, UTF-8, up to 10,000 rows / 5 MB.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setReport(null);
            setError(null);
          }}
          className="text-sm"
        />
        <button
          type="button"
          disabled={!file || busy}
          onClick={() => send(true)}
          className="rounded border border-line bg-white px-3 py-1.5 text-sm text-ink hover:bg-paper disabled:opacity-50"
        >
          {busy ? "Checking…" : "Validate (dry run)"}
        </button>
        {report?.dryRun && report.errorCount === 0 && report.valid > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => send(false)}
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            Import {report.valid} row(s)
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {report && (
        <div className="rounded border border-line bg-paper px-4 py-3 text-sm">
          {report.dryRun ? (
            <p className="text-ink">
              Dry run: {report.rows} row(s), <span className="text-accent">{report.valid} valid</span>,{" "}
              <span className={report.errorCount ? "text-danger" : "text-muted"}>{report.errorCount} error(s)</span>. Nothing was written.
            </p>
          ) : (
            <p className="text-ink">
              Imported: <span className="text-accent">{report.created} created</span>, {report.skipped} already present (same
              external_ref).
            </p>
          )}
          {report.errors.length > 0 && (
            <table className="mt-3 w-full text-left text-xs">
              <thead className="uppercase text-muted">
                <tr>
                  <th className="py-1 pr-3">Line</th>
                  <th className="py-1 pr-3">Column</th>
                  <th className="py-1">Problem</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {report.errors.map((e, i) => (
                  <tr key={i}>
                    <td className="py-1 pr-3 font-mono">{e.row + 1}</td>
                    <td className="py-1 pr-3 font-mono">{e.field ?? "—"}</td>
                    <td className="py-1 text-danger">{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {report.errorCount > report.errors.length && (
            <p className="mt-2 text-xs text-muted">…and {report.errorCount - report.errors.length} more.</p>
          )}
        </div>
      )}
    </div>
  );
}
