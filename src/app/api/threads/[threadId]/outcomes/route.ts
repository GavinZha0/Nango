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
 * GET /api/threads/[id]/outcomes — replay the current thread's
 * outcome-producing tool history into the polymorphic Outcome list
 * used by the `/outcomes` panel.
 *
 * See `docs/data-visualization.md` §6.10.
 *
 * Authorisation: any authenticated user, but only for threads whose
 * runs they own. Filter is `entity_run.owner_id = session.user.id` —
 * if the thread holds no runs the user owns, the response is
 * `{ outcomes: [] }` (we intentionally do NOT 404, because "empty
 * thread" and "not your thread" are indistinguishable to a non-owner
 * and we'd rather not leak existence).
 *
 * Polymorphic replay shape:
 *  - Pull BOTH `tool_call_chunk` rows whose `toolName` is in the
 *    rebuildable set AND every `tool_call_result` in the thread.
 *    Results have no `toolName` field, so we filter chunks first
 *    then pair by `toolCallId` in memory.
 *  - Order by `(event.ts ASC, event.seq ASC)` so chunks naturally
 *    precede their own results in the dispatch loop.
 *  - Dispatch each chunk to a per-tool rebuilder (lib/outcomes/
 *    replay-rebuilders.ts). The rebuilders are pure functions and
 *    unit-tested in isolation; this route is a thin orchestrator.
 *  - Back-fill `savedArtifactId` from `artifact` where
 *    `(source_thread_id, source_outcome_id)` matches.
 */

const ROUTE = "/api/threads/[threadId]/outcomes" as const;

/** Tool names this replay endpoint knows how to rebuild. Mirrors
 *  the dispatch switch in the loop body — adding a new tool
 *  requires touching both sides (compile-friction is intentional). */
const REBUILDABLE_TOOLS = ["render_chart", "web_search"] as const;
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
    // The threadId column on entity_run is `uuid` — Postgres throws
    // on malformed input. Catch the obvious format mismatch up front
    // so we return a friendly 400 instead of leaking a DB error.
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        threadId,
      )
    ) {
      throw new ApiError("BAD_REQUEST", 400, "threadId must be a UUID.");
    }

    const userId: string = session.user.id;

    // 1. Pull every event we might care about in one query:
    //    - tool_call_chunk rows whose toolName is in REBUILDABLE_TOOLS
    //      (filtered server-side via payload->>'toolName' so we don't
    //      deserialise unrelated tool calls).
    //    - all tool_call_result rows (results don't carry `toolName`,
    //      so we keep them all and pair in memory by toolCallId).
    //
    //    Ordering by (ts, seq) means chunks naturally precede their
    //    own results, so the pairing pass always sees the chunk first.
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
              sql`${EntityRunEventTable.payload}->>'toolName' IN ('render_chart', 'web_search')`,
            ),
            eq(EntityRunEventTable.type, "tool_call_result"),
          ),
        ),
      )
      .orderBy(asc(EntityRunEventTable.ts), asc(EntityRunEventTable.seq));

    // 2. Walk events in order; bucket chunks needing pairing, rebuild
    //    eagerly when no pairing is needed (render_chart).
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

        // render_chart rebuilds from chunk only — the result event
        // is just `{ok:true,chartId}` (a frontend tool's handler
        // return value) and useless for replay.
        if (chunk.toolName === "render_chart") {
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

    // 3. Back-fill savedArtifactId for outcomes the user has saved.
    //
    //    Defensive: this query touches `source_thread_id` /
    //    `source_outcome_id` on `artifact`. If migration 0031 hasn't
    //    been applied the columns don't exist; we MUST NOT fail the
    //    whole replay — outcomes are derived from `entity_run_event`
    //    and remain useful even without the ✓ badge. Log the pg
    //    cause so the operator sees what to fix.
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
