import "server-only";

import { NextResponse } from "next/server";
import { and, desc, ilike, isNull, or, sql, type SQL } from "drizzle-orm";

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
  const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const offsetRaw = Number(url.searchParams.get("offset") ?? 0);
  const search = (url.searchParams.get("search") ?? "").trim();

  const limit = Number.isFinite(limitRaw) ? Math.min(MAX_LIMIT, Math.max(1, limitRaw)) : DEFAULT_LIMIT;
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;

  const conditions: SQL[] = [isNull(UserTable.deletedAt)];
  if (search.length > 0) {
    const pattern = `%${search}%`;
    const searchClause = or(
      ilike(UserTable.name, pattern),
      ilike(UserTable.email, pattern),
    );
    if (searchClause) conditions.push(searchClause);
  }

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);

  const [rows, totalRows] = await Promise.all([
    db
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
      .orderBy(desc(UserTable.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ c: sql<number>`count(*)`.mapWith(Number) })
      .from(UserTable)
      .where(where)
      .then((r) => Number(r[0]?.c ?? 0)),
  ]);

  return NextResponse.json({ users: rows, total: totalRows, limit, offset });
});
