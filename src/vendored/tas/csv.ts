/**
 * lib/csv.ts
 *
 * Day-plan export to CSV (RFC 4180): one row per assignment, quoted when a
 * field contains a comma, quote, or newline. Pure functions — the browser
 * download helper is the only DOM-touching piece.
 *
 * Columns:
 *   day, date, slot_start, slot_end, gate, terminal, truck_plate, company,
 *   cargo, move, containers, status, wait_min, no_show_risk_pct
 *
 * status is "confirmed" for in-window placements and "rescheduled" for
 * placements outside the preferred window.
 */

import type { BookingRequest, SlotAssignment } from './types';
import {
  minutesToHHMM,
  SLOT_MINUTES,
  terminalForGate,
} from './types';
import { horizonDayISO } from './data';

export const PLAN_CSV_HEADER = [
  'day',
  'date',
  'slot_start',
  'slot_end',
  'gate',
  'terminal',
  'truck_plate',
  'company',
  'cargo',
  'move',
  'containers',
  'status',
  'wait_min',
  'no_show_risk_pct',
] as const;

/** RFC 4180 field escaping: quote when needed, double internal quotes. */
export function csvEscape(value: string | number): string {
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Serialize a day plan to CSV. Rows are sorted by slot start, then gate.
 * Assignments without a matching request are skipped (defensive).
 */
export function planToCsv(
  assignments: SlotAssignment[],
  requests: BookingRequest[],
): string {
  const byId = new Map(requests.map((r) => [r.id, r]));
  const rows = assignments
    .map((a) => ({ a, req: byId.get(a.requestId) }))
    .filter((x): x is { a: SlotAssignment; req: BookingRequest } => Boolean(x.req))
    .sort((x, y) => x.a.slotStart - y.a.slotStart || x.a.gate - y.a.gate);

  const lines: string[] = [PLAN_CSV_HEADER.join(',')];
  for (const { a, req } of rows) {
    const day = a.day ?? req.day ?? 0;
    lines.push(
      [
        day + 1, // 1-based day number for humans
        horizonDayISO(day),
        minutesToHHMM(a.slotStart),
        minutesToHHMM(a.slotStart + SLOT_MINUTES),
        `Gate ${a.gate + 1}`,
        terminalForGate(a.gate),
        req.truckPlate,
        req.company,
        req.cargo,
        req.move,
        req.containers,
        a.rescheduled ? 'rescheduled' : 'confirmed',
        Math.round(a.waitEstimateMin * 10) / 10,
        Math.round(a.noShowProbability * 1000) / 10,
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

/** Trigger a browser download of `csv` as `filename` (client only). */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
