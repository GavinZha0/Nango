/**
 * GET /api/threads — list the authenticated user's chat threads.
 */

import "server-only";

import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { EntityRunTable } from "@/lib/db/schema";
import { withSession } from "@/lib/http/route-handlers";
import type { SessionDescriptor } from "@/lib/backends/types";

const ROUTE = "/api/threads";

const LIST_LIMIT = 200;

interface ThreadAggregateRow {
  thread_id: string;
  started_at: Date;
  last_run_at: Date;
  turn_count: number;
  title: string | null;
}

export const GET = withSession(ROUTE, async ({ req, session }) => {
  const ownerId = session.user.id;
  const url = new URL(req.url);
  const entityId = url.searchParams.get("entityId") ?? undefined;

  // PG `array_agg` picks the first run's input_task as the thread title.
  const where = and(
    eq(EntityRunTable.ownerId, ownerId),
    isNotNull(EntityRunTable.threadId),
    isNull(EntityRunTable.parentRunId),
    entityId ? eq(EntityRunTable.entityId, entityId) : undefined,
  );

  const rows = (await db.execute(sql`
    SELECT
      ${EntityRunTable.threadId} AS thread_id,
      MIN(${EntityRunTable.startedAt}) AS started_at,
      MAX(${EntityRunTable.startedAt}) AS last_run_at,
      COUNT(*)::int AS turn_count,
      (array_agg(${EntityRunTable.inputTask} ORDER BY ${EntityRunTable.startedAt} ASC))[1] AS title
    FROM ${EntityRunTable}
    WHERE ${where}
    GROUP BY ${EntityRunTable.threadId}
    ORDER BY MAX(${EntityRunTable.startedAt}) DESC
    LIMIT ${LIST_LIMIT}
  `)) as unknown as { rows: ThreadAggregateRow[] };

  const sessions: SessionDescriptor[] = rows.rows.map((r) => ({
    session_id: r.thread_id,
    // CONTRACT: derive a one-line title from the first user message. Fallback to placeholder.
    session_name: pickTitle(r.title) || "Untitled conversation",
    created_at: toIso(r.started_at),
    updated_at: toIso(r.last_run_at),
  }));

  return Response.json(sessions);
});

function pickTitle(raw: string | null): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  // Clip to 80 chars on a word boundary. The full task remains in entity_run.input_task.
  if (trimmed.length <= 80) return trimmed;
  const cut = trimmed.slice(0, 80);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > 40 ? `${cut.slice(0, lastSpace)}…` : `${cut}…`;
}

function toIso(d: Date | string | null): string {
  if (!d) return "";
  if (d instanceof Date) return d.toISOString();
  return new Date(d).toISOString();
}
