/**
 * PATCH / DELETE /api/threads/[threadId] — update thread metadata or wipe a conversation.
 */

import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { EntityRunTable, ThreadMetadataTable } from "@/lib/db/schema";
import { ApiError, withSession } from "@/lib/http/route-handlers";
import { parseBody, uuidString } from "@/lib/http/validation";
import {
  MAX_THREAD_TITLE_CHARS,
  resolveThreadDisplayTitle,
} from "@/lib/threads/helpers";

const ROUTE = "/api/threads/[threadId]";
type RouteParams = { threadId: string };

const patchThreadSchema = z
  .object({
    pinned: z.boolean().optional(),
    title: z
      .union([z.string(), z.null()])
      .transform((v) => {
        if (v === null) return null;
        const trimmed = v.trim();
        return trimmed.length === 0 ? null : trimmed;
      })
      .refine(
        (v) => v === null || v.length <= MAX_THREAD_TITLE_CHARS,
        `Title must not exceed ${MAX_THREAD_TITLE_CHARS} characters`,
      )
      .optional(),
  })
  .refine((v) => v.pinned !== undefined || v.title !== undefined, {
    message: "At least one of `pinned` or `title` must be provided.",
  });

function parseThreadId(raw: string | undefined): string {
  const parsed = uuidString.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError("BAD_REQUEST", 400, "Invalid threadId.");
  }
  return parsed.data;
}

export const PATCH = withSession<RouteParams>(
  ROUTE,
  async ({ req, params, session }) => {
    const ownerId = session.user.id;
    const threadId = parseThreadId(params.threadId);
    const body = await parseBody(req, patchThreadSchema);

    const updated = await db.transaction(async (tx) => {
      // Confirm the thread exists and belongs to the caller; fetch its first prompt
      // so clearing a custom title returns the restored fallback title immediately.
      const runSummary = (await tx.execute(sql`
        SELECT
          (array_agg(${EntityRunTable.inputTask} ORDER BY ${EntityRunTable.startedAt} ASC))[1] AS title
        FROM ${EntityRunTable}
        WHERE ${EntityRunTable.threadId} = ${threadId}
          AND ${EntityRunTable.ownerId} = ${ownerId}
          AND ${EntityRunTable.parentRunId} IS NULL
        HAVING COUNT(*) > 0
      `)) as unknown as { rows: Array<{ title: string | null }> };

      if (runSummary.rows.length === 0) {
        throw new ApiError("NOT_FOUND", 404, "Conversation not found.");
      }

      const [existing] = await tx
        .select({
          pinnedAt: ThreadMetadataTable.pinnedAt,
          customTitle: ThreadMetadataTable.customTitle,
        })
        .from(ThreadMetadataTable)
        .where(
          and(
            eq(ThreadMetadataTable.ownerId, ownerId),
            eq(ThreadMetadataTable.threadId, threadId),
          ),
        )
        .limit(1);

      const now = new Date();
      const nextPinnedAt: Date | null =
        body.pinned === undefined
          ? (existing?.pinnedAt ?? null)
          : body.pinned
            ? (existing?.pinnedAt ?? now)
            : null;
      const nextCustomTitle: string | null =
        body.title === undefined ? (existing?.customTitle ?? null) : body.title;

      // Drop the row when all metadata fields revert to null to keep the table lean.
      if (nextPinnedAt === null && nextCustomTitle === null) {
        await tx
          .delete(ThreadMetadataTable)
          .where(
            and(
              eq(ThreadMetadataTable.ownerId, ownerId),
              eq(ThreadMetadataTable.threadId, threadId),
            ),
          );
      } else {
        await tx
          .insert(ThreadMetadataTable)
          .values({
            ownerId,
            threadId,
            pinnedAt: nextPinnedAt,
            customTitle: nextCustomTitle,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [ThreadMetadataTable.ownerId, ThreadMetadataTable.threadId],
            set: {
              pinnedAt: nextPinnedAt,
              customTitle: nextCustomTitle,
              updatedAt: now,
            },
          });
      }

      return {
        session_id: threadId,
        session_name: resolveThreadDisplayTitle(
          nextCustomTitle,
          runSummary.rows[0]?.title,
        ),
        pinned: nextPinnedAt !== null,
        pinned_at: nextPinnedAt ? nextPinnedAt.toISOString() : null,
        custom_title: nextCustomTitle,
      };
    });

    return Response.json(updated);
  },
);

export const DELETE = withSession<RouteParams>(
  ROUTE,
  async ({ params, session }) => {
    const ownerId = session.user.id;
    const threadId = parseThreadId(params.threadId);

    // CONTRACT: every clause re-checks owner_id to prevent traversal across users.
    await db.transaction(async (tx) => {
      await tx.execute(sql`
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

      await tx
        .delete(ThreadMetadataTable)
        .where(
          and(
            eq(ThreadMetadataTable.ownerId, ownerId),
            eq(ThreadMetadataTable.threadId, threadId),
          ),
        );
    });

    return new Response(null, { status: 204 });
  },
);
