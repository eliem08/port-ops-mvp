// Operating policy set by administrators (stored in `settings`, audited).
//
// Gate policy — keeps humans in the loop as tightly as the operator wants:
// - gate.autoAcceptEnabled=false → every scan that would have been accepted
//   automatically is routed to a supervisor instead (supervised pilots).
// - gate.reviewThreshold → minimum OCR confidence for automatic acceptance.
//   It can only be RAISED above the vendored GateWatch floor (70), never
//   lowered: OCR below 70 must never authorize on its own.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DEFAULT_REVIEW_THRESHOLD } from "@/vendored/gatewatch/review";

export const SettingsSchema = z
  .object({
    "gate.autoAcceptEnabled": z.boolean(),
    "gate.reviewThreshold": z.number().int().min(DEFAULT_REVIEW_THRESHOLD).max(100),
  })
  .strict();
export type Settings = z.infer<typeof SettingsSchema>;
export const SettingsPatch = SettingsSchema.partial();

export const DEFAULT_SETTINGS: Settings = {
  "gate.autoAcceptEnabled": true,
  "gate.reviewThreshold": DEFAULT_REVIEW_THRESHOLD,
};

export function getSettings(db: DatabaseSync): Settings {
  const rows = db.prepare("SELECT key, value_json FROM settings").all() as Array<{ key: string; value_json: string }>;
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (r.key in DEFAULT_SETTINGS) {
      try {
        merged[r.key] = JSON.parse(r.value_json);
      } catch {
        // corrupt value: keep the default
      }
    }
  }
  // A stored value that no longer validates falls back to the safe default.
  const parsed = SettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export function updateSettings(db: DatabaseSync, actorId: string, patch: Partial<Settings>): Settings {
  const before = getSettings(db);
  const upsert = db.prepare(
    `INSERT INTO settings (key, value_json, updated_by, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  );
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || (before as Record<string, unknown>)[key] === value) continue;
    upsert.run(key, JSON.stringify(value), actorId);
    db.prepare(
      `INSERT INTO audit_events (id, actor_id, action, entity, entity_id, detail_json)
       VALUES (?, ?, 'settings.changed', 'setting', ?, ?)`
    ).run(randomUUID(), actorId, key, JSON.stringify({ from: JSON.stringify((before as Record<string, unknown>)[key]), to: JSON.stringify(value) }));
  }
  return getSettings(db);
}

export interface GatePolicyResult {
  outcome: "auto-accept" | "human-review";
  /** Set when policy downgraded an automatic acceptance. */
  policyReason: string | null;
}

/**
 * Applies the gate policy to a scan the verification engine would accept.
 * Only ever downgrades auto-accept → human-review; never upgrades.
 */
export function applyGatePolicy(settings: Settings, confidence: number): GatePolicyResult {
  if (!settings["gate.autoAcceptEnabled"]) {
    return {
      outcome: "human-review",
      policyReason: "Policy: automatic acceptance is disabled — supervisor confirmation required.",
    };
  }
  const threshold = settings["gate.reviewThreshold"];
  if (!(Number.isFinite(confidence) && confidence >= threshold)) {
    return {
      outcome: "human-review",
      policyReason: `Policy: confidence ${Number.isFinite(confidence) ? confidence : "missing"} below the configured threshold (${threshold}).`,
    };
  }
  return { outcome: "auto-accept", policyReason: null };
}
