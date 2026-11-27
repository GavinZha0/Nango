import "server-only";

import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { ArtifactTable } from "@/lib/db/schema";
import { ApiError, withSession } from "@/lib/http/route-handlers";
import { replayThreadOutcomes } from "@/lib/outcomes/replay-thread.server";
import type { Outcome } from "@/store/outcome-store";

/**
 * GET /api/threads/[id]/outcomes — replay the thread's
 * outcome-producing tool history. Owner-scoped; threads with no
 * runs the user owns return `{ outcomes: [] }` (no 404 — "empty"
 * vs "not yours" are indistinguishable). Dispatches per-tool via
 * `lib/outcomes/replay-thread.server.ts`.
 */

const ROUTE = "/api/threads/[threadId]/outcomes" as const;

export const GET = withSession<{ threadId: string }>(
  ROUTE,
  async ({ params, session, log }) => {
    const threadId: string = params.threadId;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        threadId,
      )
    ) {
      throw new ApiError("BAD_REQUEST", 400, "threadId must be a UUID.");
    }

    const userId: string = session.user.id;
    const outcomes = await replayThreadOutcomes(threadId, userId, log);

    if (outcomes.size > 0) {
      const outcomeIds: string[] = [...outcomes.keys()];
      try {
        const saved = await db
          .select({
            id: ArtifactTable.id,
            sourceOutcomeId: ArtifactTable.sourceOutcomeId,
            sourceRevision: ArtifactTable.sourceRevision,
          })
          .from(ArtifactTable)
          .where(
            and(
              eq(ArtifactTable.createdBy, userId),
              eq(ArtifactTable.sourceThreadId, threadId),
              inArray(ArtifactTable.sourceOutcomeId, outcomeIds),
            ),
          );
        for (const row of saved) {
          if (!row.sourceOutcomeId) continue;
          const o: Outcome | undefined = outcomes.get(row.sourceOutcomeId);
          if (o) {
            o.savedArtifactId = row.id;
            o.savedRevision = row.sourceRevision ?? null;
          }
        }
      } catch (err) {
        const cause = (err as { cause?: unknown } | undefined)?.cause;
        log.error(
          {
            event: "outcomes_replay_backfill_failed",
            threadId,
            err:
              err instanceof Error
                ? { message: err.message, name: err.name }
                : String(err),
            cause:
              cause instanceof Error
                ? {
                    message: cause.message,
                    code: (cause as { code?: string }).code,
                  }
                : cause,
          },
          "back-fill of savedArtifactId failed; returning outcomes without ✓ badges",
        );
      }
    }

    return NextResponse.json({ outcomes: [...outcomes.values()] });
  },
);
