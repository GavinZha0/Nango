import "server-only";

import { NextResponse } from "next/server";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  ArtifactTable,
  EntityRunEventTable,
  EntityRunTable,
} from "@/lib/db/schema";
import { ApiError, withSession } from "@/lib/http/route-handlers";

import type { Outcome } from "@/store/outcome-store";
import {
  rebuildChartOutcome,
  rebuildWebSearchOutcome,
  type RebuildContext,
  type ToolCallChunkPayload,
  type ToolCallResultPayload,
} from "@/lib/outcomes/replay-rebuilders";

/**
 * GET /api/threads/[id]/outcomes — replay the thread's
 * outcome-producing tool history. Owner-scoped; threads with no
 * runs the user owns return `{ outcomes: [] }` (no 404 — "empty"
 * vs "not yours" are indistinguishable). Dispatches per-tool via
 * `lib/outcomes/replay-rebuilders.ts`. See docs/data-visualization.md.
 */

const ROUTE = "/api/threads/[threadId]/outcomes" as const;

/** Tool names this replay endpoint knows how to rebuild. Mirrors
 *  the dispatch switch in the loop body — adding a new tool
 *  requires touching both sides (compile-friction is intentional). */
const REBUILDABLE_TOOLS = ["generate_echarts_config", "web_search"] as const;
type RebuildableTool = (typeof REBUILDABLE_TOOLS)[number];

function isRebuildable(name: string | undefined): name is RebuildableTool {
  return (
    typeof name === "string" &&
    (REBUILDABLE_TOOLS as readonly string[]).includes(name)
  );
}

export const GET = withSession<{ threadId: string }>(
  ROUTE,
  async ({ params, session, log }) => {
    const threadId: string = params.threadId;
    // entity_run.thread_id is `uuid` — pre-validate so we return 400
    // instead of leaking a Postgres parse error.
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        threadId,
      )
    ) {
      throw new ApiError("BAD_REQUEST", 400, "threadId must be a UUID.");
    }

    const userId: string = session.user.id;

    // Pull rebuildable chunks (filtered server-side by payload->>'toolName')
    // + all result rows (no toolName in result payload — paired in memory).
    // (ts, seq) ordering puts each chunk before its result.
    const rows = await db
      .select({
        runId: EntityRunTable.id,
        entityId: EntityRunTable.entityId,
        eventType: EntityRunEventTable.type,
        eventSeq: EntityRunEventTable.seq,
        eventTs: EntityRunEventTable.ts,
        payload: EntityRunEventTable.payload,
      })
      .from(EntityRunEventTable)
      .innerJoin(
        EntityRunTable,
        eq(EntityRunTable.id, EntityRunEventTable.runId),
      )
      .where(
        and(
          eq(EntityRunTable.threadId, threadId),
          eq(EntityRunTable.ownerId, userId),
          or(
            and(
              eq(EntityRunEventTable.type, "tool_call_chunk"),
              sql`${EntityRunEventTable.payload}->>'toolName' IN ('generate_echarts_config', 'web_search')`,
            ),
            eq(EntityRunEventTable.type, "tool_call_result"),
          ),
        ),
      )
      .orderBy(asc(EntityRunEventTable.ts), asc(EntityRunEventTable.seq));

    // 2. Walk events in order; bucket chunks needing pairing, rebuild
    //    eagerly when no pairing is needed (generate_echarts_config).
    interface PendingPair {
      chunk: ToolCallChunkPayload;
      runId: string;
      entityId: string;
      ts: Date;
    }
    const pending: Map<string, PendingPair> = new Map();
    const outcomes: Map<string, Outcome> = new Map();

    const ctxFor = (p: PendingPair): RebuildContext => ({
      threadId,
      runId: p.runId,
      entityId: p.entityId,
      ts: p.ts,
      log,
    });

    for (const row of rows) {
      if (row.eventType === "tool_call_chunk") {
        const chunk = row.payload as ToolCallChunkPayload;
        if (!isRebuildable(chunk.toolName)) continue;

        // generate_echarts_config rebuilds from chunk only — the
        // result event is a server-side echo of the same payload,
        // and the chunk already carries everything needed to
        // reconstruct the outcome.
        if (chunk.toolName === "generate_echarts_config") {
          const built = rebuildChartOutcome(chunk, {
            threadId,
            runId: row.runId,
            entityId: row.entityId,
            ts: row.eventTs,
            log,
          });
          if (built) outcomes.set(built.id, built.outcome);
          continue;
        }

        // web_search needs the matching tool_call_result to know
        // the search hits — stash until the result arrives.
        pending.set(chunk.toolCallId, {
          chunk,
          runId: row.runId,
          entityId: row.entityId,
          ts: row.eventTs,
        });
      } else if (row.eventType === "tool_call_result") {
        const result = row.payload as ToolCallResultPayload;
        const pair = pending.get(result.toolCallId);
        if (!pair) continue; // result for an irrelevant tool — ignore.
        const built = rebuildWebSearchOutcome(pair.chunk, result, ctxFor(pair));
        pending.delete(result.toolCallId);
        if (built) outcomes.set(built.id, built.outcome);
      }
    }

    // 3. Back-fill savedArtifactId. Defensive try/catch: missing
    //    columns ("source_thread_id" / "source_outcome_id") must not
    //    fail the whole replay — outcomes are still derivable.
    if (outcomes.size > 0) {
      const outcomeIds: string[] = [...outcomes.keys()];
      try {
        const saved = await db
          .select({
            id: ArtifactTable.id,
            sourceOutcomeId: ArtifactTable.sourceOutcomeId,
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
          if (o) o.savedArtifactId = row.id;
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
            hint: "If pg says 'column \"source_thread_id\" does not exist', run `pnpm db:migrate` to apply migration 0031.",
          },
          "back-fill of savedArtifactId failed; returning outcomes without ✓ badges",
        );
      }
    }

    return NextResponse.json({ outcomes: [...outcomes.values()] });
  },
);
