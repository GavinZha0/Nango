import "server-only";

import { NextResponse } from "next/server";
import { asc, desc, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { UserTable } from "@/lib/db/schema";
import { withAdmin } from "@/lib/http/route-handlers";

const ROUTE = "/api/admin/users";

// GET /api/admin/users
// Active users only (deleted_at IS NULL). Mirrors the shape of better-auth's
// admin.listUsers so the table component is a near-drop-in.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const GET = withAdmin(ROUTE, async ({ req }) => {
  const url = new URL(req.url);
  const hasLimit = url.searchParams.has("limit");
  const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const offsetRaw = Number(url.searchParams.get("offset") ?? 0);

  const limit = Number.isFinite(limitRaw) ? Math.min(MAX_LIMIT, Math.max(1, limitRaw)) : DEFAULT_LIMIT;
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;

  const where = isNull(UserTable.deletedAt);

  let userQuery = db
    .select({
      id: UserTable.id,
      name: UserTable.name,
      email: UserTable.email,
      emailVerified: UserTable.emailVerified,
      role: UserTable.role,
      banned: UserTable.banned,
      banReason: UserTable.banReason,
      banExpires: UserTable.banExpires,
      org: UserTable.org,
      createdAt: UserTable.createdAt,
      updatedAt: UserTable.updatedAt,
      lastActiveAt: sql<string | null>`(
        SELECT MAX(created_at)
        FROM entity_run
        WHERE entity_run.owner_id = "user".id
          AND entity_run.initiator IN ('user', 'orchestrator')
      )`,
    })
    .from(UserTable)
    .where(where)
    .orderBy(asc(sql`lower(${UserTable.name})`), desc(UserTable.createdAt))
    .$dynamic();

  if (hasLimit) {
    userQuery = userQuery.limit(limit).offset(offset);
    const rows = await userQuery;
    const totalRows = await db
      .select({ c: sql<number>`count(*)`.mapWith(Number) })
      .from(UserTable)
      .where(where)
      .then((r) => Number(r[0]?.c ?? 0));
    return NextResponse.json({ users: rows, total: totalRows, limit, offset });
  }

  const rows = await userQuery;
  return NextResponse.json({ users: rows, total: rows.length, limit: null, offset: 0 });
});
