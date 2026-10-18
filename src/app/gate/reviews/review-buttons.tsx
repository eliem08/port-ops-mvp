"use client";

// Approve / reject buttons for a review item. Rendered only for
// supervisor+ roles; the server action enforces the role too.

import { useState } from "react";
import { decideReviewAction } from "@/lib/actions";

export function ReviewDecisionButtons({ reviewId }: { reviewId: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  const [note, setNote] = useState("");

  async function decide(decision: "approved" | "rejected") {
    setBusy(decision);
    setMessage(null);
    setError(null);
    const r = await decideReviewAction(reviewId, decision, note);
    setBusy(null);
    if (r.ok) {
      setMessage(r.message);
      window.location.reload();
    } else {
      setError(r.message);
    }
  }

  return (
    <div className="space-y-2">
      {message && (
        <p role="status" className="text-sm text-ok">{message}</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">{error}</p>
      )}
      <label className="block">
        <span className="mb-1 block text-xs text-muted">Decision note (optional)</span>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          placeholder="e.g. plate read corrected against booking"
          className="w-full rounded border border-line px-2 py-1.5 text-sm text-ink"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => decide("approved")}
          disabled={busy !== null}
          className="rounded bg-ok px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy === "approved" ? "Approving…" : "Approve"}
        </button>
        <button
          type="button"
          onClick={() => decide("rejected")}
          disabled={busy !== null}
          className="rounded bg-danger px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy === "rejected" ? "Rejecting…" : "Reject"}
        </button>
      </div>
    </div>
  );
}
