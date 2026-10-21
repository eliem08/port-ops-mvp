// "Synthetic demo data" tag — rendered only while the database contains the
// synthetic demo seed, so it is never shown next to a customer's real data.
// Server component (reads the database); keep it out of client bundles.

import { getDb } from "@/lib/db/client";
import { demoDataPresent } from "@/lib/deployment";

export function SyntheticTag() {
  if (!demoDataPresent(getDb())) return null;
  return (
    <span className="inline-block rounded border border-warn/40 bg-warn/10 px-2 py-0.5 text-xs font-medium text-warn">
      Synthetic demo data
    </span>
  );
}
