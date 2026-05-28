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
import { ApiError, withAdmin } from "@/lib/http/route-handlers";
import { pickWorstStatus } from "@/lib/runner/thread-metrics";

/**
 * GET /api/admin/threads
 *
 * One row per `thread_id`, surfaced to the admin thread list UI.
 *
 * Column-by-column source:
 *   - timestamp      ← first top-level run's `created_at`
 *   - task           ← first top-level run's `input_task`
 *   - entity         ← first top-level run's `entity_*` columns (and joins)
 *   - owner          ← first top-level run's `owner_id` (and join)
 *   - runCount       ← COUNT(top-level runs in thread)
 *   - duration       ← SUM(finished_at - started_at) of top-level runs
 *   - worstStatus    ← highest-priority status across ALL runs (top-level
 *                      + sub-runs), used to tint the task column
 *
 * Status filter is "inclusive": a thread is selected when ANY of its
 * runs (top-level or sub) match a requested status. Mirrors the
 * "one failed → red task" tinting rule so the filter and the colour
 * agree.
 */

const ROUTE = "/api/admin/threads";

const querySchema = z.object({
  /** Pipe-separated list (e.g. "failed|running"). */
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = withAdmin(ROUTE, async ({ req }) => {
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

  // ------------------------------------------------------------------
  // Step 1 — pick the candidate thread ids for this page.
  //
  // Aggregate over ALL runs per thread so the status filter sees both
  // top-level and sub-run statuses. Anchor sort = first top-level run's
  // created_at (desc) so the most-recently-started threads bubble up.
  // ------------------------------------------------------------------
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

  const threadCandidates = await db
    .select({
      threadId: EntityRunTable.threadId,
      anchorCreatedAt: anchorSort,
    })
    .from(EntityRunTable)
    .where(isNotNull(EntityRunTable.threadId))
    .groupBy(EntityRunTable.threadId)
    .having(having)
    .orderBy(desc(anchorSort))
    .limit(limit)
    .offset(offset);

  // Total threads for pagination — same filter, no anchor/limit. We
  // wrap the GROUP BY in a sub-select and count its rows.
  //
  // QUIRK: `db.execute` returns the pg driver's full result envelope
  // ({ rows, rowCount, ... }), NOT a plain array — destructuring it
  // as iterable throws "is not iterable" at runtime. Same pattern as
  // `src/app/api/threads/route.ts`: cast to { rows: ... } and read
  // `.rows[0]`.
  const totalResult = (await db.execute(
    sql<{ totalThreads: number }>`
      SELECT COUNT(*)::int AS "totalThreads"
      FROM (
        SELECT 1
        FROM ${EntityRunTable}
        WHERE ${EntityRunTable.threadId} IS NOT NULL
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

  // ------------------------------------------------------------------
  // Step 2 — anchor run details for the candidate threads.
  //
  // Fetch every top-level run for the page's threads, ordered so the
  // first row per thread is the anchor. Dedup to anchor-only in
  // TypeScript — keeps the SQL simple (no window function) and the
  // overfetch is bounded (top-level runs per thread are typically <20
  // and we page by at most 200 threads).
  // ------------------------------------------------------------------
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
      createdAt: EntityRunTable.createdAt,
    })
    .from(EntityRunTable)
    .leftJoin(UserTable, eq(EntityRunTable.ownerId, UserTable.id))
    .leftJoin(
      BuiltinAgentTable,
      // text = uuid mismatch — same coercion pattern as the runs route.
      sql`${EntityRunTable.entityId} = ${BuiltinAgentTable.id}::text`,
    )
    .leftJoin(
      CredentialTable,
      eq(EntityRunTable.credentialId, CredentialTable.id),
    )
    .where(
      and(
        inArray(EntityRunTable.threadId, threadIds),
        isNull(EntityRunTable.parentRunId),
      ),
    )
    .orderBy(asc(EntityRunTable.createdAt));

  const anchorByThread = new Map<string, typeof topLevelRuns[number]>();
  for (const r of topLevelRuns) {
    const tid = r.threadId as string;
    if (!anchorByThread.has(tid)) anchorByThread.set(tid, r);
  }

  // ------------------------------------------------------------------
  // Step 3 — per-thread aggregates: count + cumulative duration + the
  // set of statuses seen across the thread (used to pick worstStatus).
  // ------------------------------------------------------------------
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
    .where(inArray(EntityRunTable.threadId, threadIds))
    .groupBy(EntityRunTable.threadId);

  const aggByThread = new Map(
    aggregates.map((a) => [a.threadId as string, a]),
  );

  // ------------------------------------------------------------------
  // Stitch in the order of `threadCandidates` (preserves the sort).
  // ------------------------------------------------------------------
  const rows = threadCandidates.flatMap((c) => {
    const tid = c.threadId as string;
    const anchor = anchorByThread.get(tid);
    const agg = aggByThread.get(tid);
    // Defensive — anchor / agg should always exist for a candidate.
    // Empty arrays from flatMap silently drop malformed rows rather
    // than emit a half-filled object.
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
