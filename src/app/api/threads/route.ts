/**
 * GET /api/threads — list the authenticated user's chat threads.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { EntityRunTable, ThreadMetadataTable } from "@/lib/db/schema";
import { withSession } from "@/lib/http/route-handlers";
import type { SessionDescriptor } from "@/lib/backends/types";
import { resolveThreadDisplayTitle } from "@/lib/threads/helpers";

const ROUTE = "/api/threads";

const LIST_LIMIT = 200;

interface ThreadAggregateRow {
  thread_id: string;
  started_at: Date;
  last_run_at: Date;
  turn_count: number;
  title: string | null;
  pinned_at: Date | null;
  custom_title: string | null;
}

export const GET = withSession(ROUTE, async ({ req, session }) => {
  const ownerId = session.user.id;
  const url = new URL(req.url);
  const entityId = url.searchParams.get("entityId") ?? undefined;

  // Pinned threads sort ahead of unpinned threads so LIST_LIMIT never drops them.
  const rows = (await db.execute(sql`
    SELECT
      er.thread_id AS thread_id,
      MIN(er.started_at) AS started_at,
      MAX(er.started_at) AS last_run_at,
      COUNT(*)::int AS turn_count,
      (array_agg(er.input_task ORDER BY er.started_at ASC))[1] AS title,
      tm.pinned_at AS pinned_at,
      tm.custom_title AS custom_title
    FROM ${EntityRunTable} er
    LEFT JOIN ${ThreadMetadataTable} tm
      ON tm.owner_id = er.owner_id AND tm.thread_id = er.thread_id
    WHERE er.owner_id = ${ownerId}
      AND er.thread_id IS NOT NULL
      AND er.parent_run_id IS NULL
      ${entityId ? sql`AND er.entity_id = ${entityId}` : sql``}
    GROUP BY er.thread_id, tm.pinned_at, tm.custom_title
    ORDER BY
      (tm.pinned_at IS NOT NULL) DESC,
      tm.pinned_at DESC NULLS LAST,
      MAX(er.started_at) DESC
    LIMIT ${LIST_LIMIT}
  `)) as unknown as { rows: ThreadAggregateRow[] };

  const sessions: SessionDescriptor[] = rows.rows.map((r) => ({
    session_id: r.thread_id,
    // CONTRACT: custom title overrides the prompt-derived one-line title.
    session_name: resolveThreadDisplayTitle(r.custom_title, r.title),
    created_at: toIso(r.started_at),
    updated_at: toIso(r.last_run_at),
    pinned: r.pinned_at !== null,
    pinned_at: r.pinned_at ? toIso(r.pinned_at) : null,
    custom_title: r.custom_title ?? null,
  }));

  return Response.json(sessions);
});

function toIso(d: Date | string | null): string {
  if (!d) return "";
  if (d instanceof Date) return d.toISOString();
  return new Date(d).toISOString();
}
