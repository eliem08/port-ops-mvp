// POST /api/gate/reviews/[id]/decide — supervisor approves/rejects a review item.
// SEPARATION OF DUTIES: the supervisor who submitted the scan cannot decide
// its review (verified_by == session.userId → 403).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireApiRole, jsonError } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { audit } from "@/lib/audit";
import { readJsonLimited, handleRouteError, ok } from "@/lib/route-helpers";

const DecideInput = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    note: z.string().max(500).nullable().optional(),
  })
  .strict();

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole(req, "supervisor");
    const { id } = await ctx.params;
    const body = await readJsonLimited(req);

    const parsed = DecideInput.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            code: "validation_error",
            message: "Invalid decision.",
            details: parsed.error.issues,
          },
        },
        { status: 400 }
      );
    }

    const db = getDb();
    const item = db
      .prepare(
        `SELECT id, event_id, status, decided_by, decided_at, note, created_at
         FROM review_items WHERE id = ?`
      )
      .get(id) as
      | {
          id: string;
          event_id: string;
          status: string;
          decided_by: string | null;
          decided_at: string | null;
          note: string | null;
          created_at: string;
        }
      | undefined;

    if (!item) {
      return jsonError(404, "not_found", "Review item not found.");
    }
    if (item.status !== "pending") {
      return jsonError(
        409,
        "already_decided",
        `Review item was already decided (${item.status}).`
      );
    }

    const event = db
      .prepare(
        "SELECT verified_by FROM gate_verification_events WHERE id = ?"
      )
      .get(item.event_id) as { verified_by: string } | undefined;
    if (!event) {
      return jsonError(500, "internal_error", "Originating scan record is missing.");
    }

    // Separation of duties: no deciding your own scan's review.
    if (event.verified_by === session.userId) {
      return jsonError(
        403,
        "separation_of_duties",
        "You cannot decide the review for a scan you submitted."
      );
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE review_items
       SET status = ?, decided_by = ?, decided_at = ?, note = ?
       WHERE id = ?`
    ).run(parsed.data.decision, session.userId, now, parsed.data.note ?? null, id);

    audit(session.userId, "review.decided", "review_item", id, {
      decision: parsed.data.decision,
    });

    return ok({
      id: item.id,
      eventId: item.event_id,
      status: parsed.data.decision,
      decidedBy: session.userId,
      decidedAt: now,
      note: parsed.data.note ?? null,
      createdAt: item.created_at,
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
