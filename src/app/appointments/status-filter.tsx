"use client";

import { useRouter } from "next/navigation";
import type { AppointmentStatus as StatusT } from "@/contracts";

export function StatusFilter({
  current,
  options,
}: {
  current?: StatusT;
  options: StatusT[];
}) {
  const router = useRouter();

  return (
    <form
      method="get"
      className="flex items-center gap-2"
      onSubmit={(e) => e.preventDefault()}
    >
      <label htmlFor="status-filter" className="text-xs text-muted">
        Filter by status
      </label>
      <select
        id="status-filter"
        name="status"
        value={current ?? ""}
        className="rounded border border-line bg-white px-2 py-1 text-sm text-ink"
        onChange={(e) => {
          const v = e.target.value;
          router.push(v ? `/appointments?status=${encodeURIComponent(v)}` : "/appointments");
        }}
      >
        <option value="">All</option>
        {options.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </form>
  );
}
