import "server-only";

import { NextResponse } from "next/server";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { LoginEventTable, UserTable } from "@/lib/db/schema";
import { withAdmin } from "@/lib/http/route-handlers";

const ROUTE = "/api/admin/login-events";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const GET = withAdmin(ROUTE, async ({ req }) => {
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const offsetRaw = Number(url.searchParams.get("offset") ?? 0);
  const userId = url.searchParams.get("userId")?.trim() || null;
  const eventType = url.searchParams.get("eventType")?.trim() || null;

  const limit = Number.isFinite(limitRaw)
    ? Math.min(MAX_LIMIT, Math.max(1, limitRaw))
    : DEFAULT_LIMIT;
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;

  const conditions: SQL[] = [];
  if (userId) conditions.push(eq(LoginEventTable.userId, userId));
  if (eventType) conditions.push(eq(LoginEventTable.eventType, eventType));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, totalResult] = await Promise.all([
    db
      .select({
        id: LoginEventTable.id,
        userId: LoginEventTable.userId,
        userName: UserTable.name,
        userEmail: UserTable.email,
        eventType: LoginEventTable.eventType,
        ipAddress: LoginEventTable.ipAddress,
        userAgent: LoginEventTable.userAgent,
        detail: LoginEventTable.detail,
        createdAt: LoginEventTable.createdAt,
      })
      .from(LoginEventTable)
      .leftJoin(UserTable, eq(LoginEventTable.userId, UserTable.id))
      .where(where)
      .orderBy(desc(LoginEventTable.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ c: sql<number>`count(*)`.mapWith(Number) })
      .from(LoginEventTable)
      .where(where),
  ]);

  const total = Number(totalResult[0]?.c ?? 0);

  return NextResponse.json({ events: rows, total, limit, offset });
});
