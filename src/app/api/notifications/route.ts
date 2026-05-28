import "server-only";

import { NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { NotificationTable } from "@/lib/db/schema";
import { withSession } from "@/lib/http/route-handlers";

const ROUTE = "/api/notifications";

/**
 * GET /api/notifications?unread=1&limit=50
 * List the caller's notifications, newest first.
 */
const querySchema = z.object({
  unread: z.enum(["1", "0", "true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const GET = withSession(ROUTE, async ({ req, session }) => {
  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    unread: url.searchParams.get("unread") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "BAD_REQUEST", message: "Invalid query parameters." },
      { status: 400 },
    );
  }
  const onlyUnread =
    parsed.data.unread === "1" || parsed.data.unread === "true";

  const where = onlyUnread
    ? and(
        eq(NotificationTable.ownerId, session.user.id),
        isNull(NotificationTable.readAt),
      )
    : eq(NotificationTable.ownerId, session.user.id);

  const rows = await db
    .select()
    .from(NotificationTable)
    .where(where)
    .orderBy(desc(NotificationTable.createdAt))
    .limit(parsed.data.limit);

  return NextResponse.json(rows);
});

/**
 * POST /api/notifications/mark-all-read
 * Convenience: flip every unread row owned by the caller in one
 * shot. The dedicated per-id PATCH route lives in `[id]/route.ts`.
 */
export const POST = withSession(ROUTE, async ({ session }) => {
  const updated = await db
    .update(NotificationTable)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(NotificationTable.ownerId, session.user.id),
        isNull(NotificationTable.readAt),
      ),
    )
    .returning({ id: NotificationTable.id });
  return NextResponse.json({ ok: true, count: updated.length });
});
