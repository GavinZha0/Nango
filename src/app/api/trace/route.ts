import "server-only";

import { NextResponse } from "next/server";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  BuiltinAgentTable,
  CredentialTable,
  EntityRunTable,
  UserTable,
} from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { pickWorstStatus } from "@/lib/runner/thread-metrics";

/**
 * GET /api/trace — list traces for the editor user.
 * Strictly filters runs by the calling user's id (session.user.id).
 */

const ROUTE = "/api/trace";

const querySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = withEditor(ROUTE, async ({ req, session }) => {
  const url = new URL(req.url);
  const parsed = querySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!parsed.success) {
    throw new ApiError(
      "BAD_REQUEST",
      400,
      "Invalid query parameters.",
      parsed.error.format(),
    );
  }
  const { status, limit, offset } = parsed.data;

  const statusFilter: ReadonlyArray<string> = status
    ? status.split("|").filter(Boolean)
    : [];

  const havingConds: SQL[] = [];
  if (statusFilter.length > 0) {
    havingConds.push(
      sql`bool_or(${EntityRunTable.status} IN ${statusFilter})`,
    );
  }
  const having = havingConds.length > 0 ? and(...havingConds) : undefined;

  const anchorSort = sql<Date>`
    min(${EntityRunTable.createdAt})
      FILTER (WHERE ${EntityRunTable.parentRunId} IS NULL)
  `;

  // Step 1 — candidate thread ids owned by the session user.
  const threadCandidates = await db
    .select({
      threadId: EntityRunTable.threadId,
      anchorCreatedAt: anchorSort,
    })
    .from(EntityRunTable)
    .where(
      and(
        isNotNull(EntityRunTable.threadId),
        eq(EntityRunTable.ownerId, session.user.id),
      ),
    )
    .groupBy(EntityRunTable.threadId)
    .having(having)
    .orderBy(desc(anchorSort))
    .limit(limit)
    .offset(offset);

  // Total threads owned by the session user.
  const totalResult = (await db.execute(
    sql<{ totalThreads: number }>`
      SELECT COUNT(*)::int AS "totalThreads"
      FROM (
        SELECT 1
        FROM ${EntityRunTable}
        WHERE ${EntityRunTable.threadId} IS NOT NULL
          AND ${EntityRunTable.ownerId} = ${session.user.id}::uuid
        GROUP BY ${EntityRunTable.threadId}
        ${
          statusFilter.length > 0
            ? sql`HAVING bool_or(${EntityRunTable.status} IN ${statusFilter})`
            : sql``
        }
      ) t
    `,
  )) as unknown as { rows: ReadonlyArray<{ totalThreads: number }> };
  const totalThreads = totalResult.rows[0]?.totalThreads ?? 0;

  if (threadCandidates.length === 0) {
    return NextResponse.json({
      rows: [],
      total: totalThreads,
      limit,
      offset,
    });
  }

  const threadIds = threadCandidates.map((c) => c.threadId as string);

  // Step 2 — anchor run per thread owned by the session user.
  const topLevelRuns = await db
    .select({
      threadId: EntityRunTable.threadId,
      entityId: EntityRunTable.entityId,
      entityKind: EntityRunTable.entityKind,
      entitySource: EntityRunTable.entitySource,
      credentialId: EntityRunTable.credentialId,
      builtinName: BuiltinAgentTable.name,
      credentialName: CredentialTable.name,
      inputTask: EntityRunTable.inputTask,
      ownerId: EntityRunTable.ownerId,
      ownerEmail: UserTable.email,
      ownerName: UserTable.name,
      initiator: EntityRunTable.initiator,
      createdAt: EntityRunTable.createdAt,
    })
    .from(EntityRunTable)
    .leftJoin(UserTable, eq(EntityRunTable.ownerId, UserTable.id))
    .leftJoin(
      BuiltinAgentTable,
      sql`${EntityRunTable.entityId} = ${BuiltinAgentTable.id}::text`,
    )
    .leftJoin(
      CredentialTable,
      eq(EntityRunTable.credentialId, CredentialTable.id),
    )
    .where(
      and(
        inArray(EntityRunTable.threadId, threadIds),
        eq(EntityRunTable.ownerId, session.user.id),
        isNull(EntityRunTable.parentRunId),
      ),
    )
    .orderBy(asc(EntityRunTable.createdAt));

  const anchorByThread = new Map<string, typeof topLevelRuns[number]>();
  for (const r of topLevelRuns) {
    const tid = r.threadId as string;
    if (!anchorByThread.has(tid)) anchorByThread.set(tid, r);
  }

  // Step 3 — aggregates.
  const aggregates = await db
    .select({
      threadId: EntityRunTable.threadId,
      topLevelCount:
        sql<number>`COUNT(*) FILTER (WHERE ${EntityRunTable.parentRunId} IS NULL)`.mapWith(
          Number,
        ),
      cumulativeDurationMs: sql<number>`
        COALESCE(
          SUM(
            EXTRACT(
              EPOCH FROM (${EntityRunTable.finishedAt} - ${EntityRunTable.startedAt})
            )::numeric * 1000
          ) FILTER (
            WHERE ${EntityRunTable.parentRunId} IS NULL
              AND ${EntityRunTable.startedAt} IS NOT NULL
              AND ${EntityRunTable.finishedAt} IS NOT NULL
          ),
          0
        )
      `.mapWith(Number),
      statuses: sql<string[]>`ARRAY_AGG(DISTINCT ${EntityRunTable.status})`,
    })
    .from(EntityRunTable)
    .where(
      and(
        inArray(EntityRunTable.threadId, threadIds),
        eq(EntityRunTable.ownerId, session.user.id),
      ),
    )
    .groupBy(EntityRunTable.threadId);

  const aggByThread = new Map(
    aggregates.map((a) => [a.threadId as string, a]),
  );

  const rows = threadCandidates.flatMap((c) => {
    const tid = c.threadId as string;
    const anchor = anchorByThread.get(tid);
    const agg = aggByThread.get(tid);
    if (!anchor || !agg) return [];
    return [
      {
        threadId: tid,
        firstRunCreatedAt: anchor.createdAt,
        firstRunEntityId: anchor.entityId,
        firstRunEntityKind: anchor.entityKind,
        firstRunEntitySource: anchor.entitySource,
        firstRunBuiltinName: anchor.builtinName,
        firstRunCredentialName: anchor.credentialName,
        firstRunTask: anchor.inputTask,
        ownerId: anchor.ownerId,
        ownerEmail: anchor.ownerEmail,
        ownerName: anchor.ownerName,
        initiator: anchor.initiator,
        runCount: agg.topLevelCount,
        cumulativeDurationMs: agg.cumulativeDurationMs,
        worstStatus: pickWorstStatus(agg.statuses ?? []),
      },
    ];
  });

  return NextResponse.json({
    rows,
    total: totalThreads,
    limit,
    offset,
  });
});
