"use client";

// User chip in the header: name + role (links to the account page) and logout.

import Link from "next/link";
import { useState } from "react";

export function UserChip({ label, role }: { label: string; role: string }) {
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <div className="flex items-center gap-3">
      <Link href="/account" className="text-right hover:underline" title="Account and security">
        <p className="text-sm font-medium text-ink">{label}</p>
        <p className="text-xs text-muted">Role: {role}</p>
      </Link>
      <button
        type="button"
        onClick={logout}
        disabled={busy}
        className="rounded border border-line bg-white px-3 py-1.5 text-sm text-ink hover:bg-paper disabled:opacity-50"
        aria-label="Log out"
      >
        {busy ? "Logging out…" : "Log out"}
      </button>
    </div>
  );
}
