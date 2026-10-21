// Operating policy (administrator). Changes are audited.

import { getDb } from "@/lib/db/client";
import { getSettings } from "@/lib/settings";
import { Card } from "@/components/ui";
import { SettingsForm } from "./settings-form";

export default function SettingsPage() {
  const settings = getSettings(getDb());
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink">Settings</h1>
        <p className="text-sm text-muted">Operating policy for this installation. Every change is recorded in the audit trail.</p>
      </div>
      <Card title="Gate verification — human in the loop">
        <SettingsForm initial={settings} />
      </Card>
    </div>
  );
}
