/**
 * DELETE /api/threads/[threadId] — wipe a conversation entirely.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { EntityRunTable } from "@/lib/db/schema";
import { withSession } from "@/lib/http/route-handlers";

const ROUTE = "/api/threads/[threadId]";
type RouteParams = { threadId: string };

export const DELETE = withSession<RouteParams>(
  ROUTE,
  async ({ params, session }) => {
    const ownerId = session.user.id;
    const threadId = params.threadId;

    if (!threadId) {
      return Response.json(
        { ok: false, code: "BAD_REQUEST", message: "threadId required" },
        { status: 400 },
      );
    }

    // CONTRACT: every clause re-checks owner_id to prevent traversal across users.
    await db.execute(sql`
      WITH RECURSIVE run_tree AS (
        SELECT ${EntityRunTable.id} AS id
        FROM ${EntityRunTable}
        WHERE ${EntityRunTable.threadId} = ${threadId}
          AND ${EntityRunTable.ownerId} = ${ownerId}
          AND ${EntityRunTable.parentRunId} IS NULL
        UNION ALL
        SELECT er.${sql.raw("id")}
        FROM ${EntityRunTable} er
        JOIN run_tree rt ON er.${sql.raw("parent_run_id")} = rt.id
        WHERE er.${sql.raw("owner_id")} = ${ownerId}
      )
      DELETE FROM ${EntityRunTable}
      WHERE ${EntityRunTable.id} IN (SELECT id FROM run_tree)
        AND ${EntityRunTable.ownerId} = ${ownerId}
    `);

    return new Response(null, { status: 204 });
  },
);
