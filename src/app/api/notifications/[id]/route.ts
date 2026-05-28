import "server-only";

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { NotificationTable } from "@/lib/db/schema";
import { ApiError, withSession } from "@/lib/http/route-handlers";

const ROUTE = "/api/notifications/[id]";

/**
 * PATCH — mark one notification as read. Body is empty; the action
 * is implicit. Idempotent (re-marking an already-read row is a no-op
 * thanks to the WHERE).
 */
export const PATCH = withSession<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const updated = await db
      .update(NotificationTable)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(NotificationTable.id, params.id),
          eq(NotificationTable.ownerId, session.user.id),
        ),
      )
      .returning({ id: NotificationTable.id });
    if (updated.length === 0) {
      throw new ApiError("NOT_FOUND", 404, "Notification not found.");
    }
    return NextResponse.json({ ok: true });
  },
);

/**
 * DELETE — permanent removal. We don't soft-delete: a "trash" UX is
 * out of scope for v1, and the notification's underlying run row
 * stays in entity_run independently.
 */
export const DELETE = withSession<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const removed = await db
      .delete(NotificationTable)
      .where(
        and(
          eq(NotificationTable.id, params.id),
          eq(NotificationTable.ownerId, session.user.id),
        ),
      )
      .returning({ id: NotificationTable.id });
    if (removed.length === 0) {
      throw new ApiError("NOT_FOUND", 404, "Notification not found.");
    }
    return new NextResponse(null, { status: 204 });
  },
);
