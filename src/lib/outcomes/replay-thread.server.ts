import "server-only";

import { and, asc, eq, or, sql } from "drizzle-orm";
import { GENERATIVE_UI_ACTIVITY_TYPE } from "@copilotkit/shared/generative-ui";

import { db } from "@/lib/db";
import { EntityRunEventTable, EntityRunTable } from "@/lib/db/schema";
import {
  applySurfaceDelta,
  type SurfacePatchOp,
} from "@/lib/generative-ui/surface";
import { normalizeOutcomeId } from "@/lib/outcomes/schema";
import {
  rebuildA2UiOutcome,
  rebuildBentoSlideEditOutcome,
  rebuildBentoSlidesOutcome,
  rebuildChartOutcome,
  rebuildHtmlPageOutcome,
  rebuildImageOutcome,
  rebuildWebSearchOutcome,
  type RebuildContext,
  type ToolCallChunkPayload,
  type ToolCallResultPayload,
} from "@/lib/outcomes/replay-rebuilders";
import type { Outcome } from "@/store/outcome-store";

interface ReplayLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Replay all outcome-producing events in a thread for `ownerId`.
 * Shared by `GET /api/threads/[threadId]/outcomes` and `saveArtifact`
 * so live replay and saved static snapshots produce the exact same blocks.
 */
export async function replayThreadOutcomes(
  threadId: string,
  ownerId: string,
  log: ReplayLogger,
): Promise<Map<string, Outcome>> {
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
        eq(EntityRunTable.ownerId, ownerId),
        or(
          eq(EntityRunEventTable.type, "tool_call_chunk"),
          eq(EntityRunEventTable.type, "tool_call_result"),
          and(
            or(
              eq(EntityRunEventTable.type, "activity_snapshot"),
              eq(EntityRunEventTable.type, "activity_delta"),
            ),
            sql`${EntityRunEventTable.payload}->>'activityType' = ${GENERATIVE_UI_ACTIVITY_TYPE}`,
          ),
        ),
      ),
    )
    .orderBy(
      asc(EntityRunTable.createdAt),
      asc(EntityRunEventTable.seq),
      asc(EntityRunEventTable.ts),
    );

  interface PendingPair {
    chunk: ToolCallChunkPayload;
    runId: string;
    entityId: string;
    ts: Date;
  }
  const pending = new Map<string, PendingPair>();
  const outcomes = new Map<string, Outcome>();

  interface SurfaceDraft {
    raw: Record<string, unknown>;
    runId: string;
    entityId: string;
    ts: Date;
  }
  const surfaceDrafts = new Map<string, SurfaceDraft>();

  const ctxFor = (p: PendingPair): RebuildContext => ({
    threadId,
    runId: p.runId,
    entityId: p.entityId,
    ts: p.ts,
    log,
  });

  for (const row of rows) {
    const eventTs = row.eventTs ?? new Date();
    const entityId = row.entityId ?? "";
    if (row.eventType === "tool_call_chunk") {
      const chunk = row.payload as ToolCallChunkPayload;

      if (chunk.toolName === "generate_echarts_config") {
        const built = rebuildChartOutcome(chunk, {
          threadId,
          runId: row.runId,
          entityId,
          ts: eventTs,
          log,
        });
        if (built) outcomes.set(built.id, built.outcome);
        continue;
      }

      if (chunk.toolName === "generate_html_page") {
        const built = rebuildHtmlPageOutcome(chunk, {
          threadId,
          runId: row.runId,
          entityId,
          ts: eventTs,
          log,
        });
        if (built) outcomes.set(built.id, built.outcome);
        continue;
      }

      pending.set(chunk.toolCallId, {
        chunk,
        runId: row.runId,
        entityId,
        ts: eventTs,
      });
    } else if (row.eventType === "tool_call_result") {
      const result = row.payload as ToolCallResultPayload;
      const pair = pending.get(result.toolCallId);

      if (pair && pair.chunk.toolName === "generate_bento_slides") {
        pending.delete(result.toolCallId);
        let priorOutcome: Outcome | undefined;
        try {
          const raw = JSON.parse(pair.chunk.args) as Record<string, unknown>;
          if (raw && typeof raw.outcome_id === "string") {
            priorOutcome = outcomes.get(normalizeOutcomeId(raw.outcome_id));
          }
        } catch {
          // parse error handled inside rebuilder
        }
        const built = rebuildBentoSlidesOutcome(
          pair.chunk,
          ctxFor(pair),
          priorOutcome,
          result,
        );
        if (built) outcomes.set(built.id, built.outcome);
        continue;
      }

      if (pair && pair.chunk.toolName === "edit_bento_slides") {
        pending.delete(result.toolCallId);
        let priorOutcome: Outcome | undefined;
        try {
          const raw = JSON.parse(pair.chunk.args) as Record<string, unknown>;
          if (raw && typeof raw.outcome_id === "string") {
            priorOutcome = outcomes.get(normalizeOutcomeId(raw.outcome_id));
          }
        } catch {
          // parse error handled inside rebuilder
        }
        const built = rebuildBentoSlideEditOutcome(
          pair.chunk,
          ctxFor(pair),
          priorOutcome,
          result,
        );
        if (built) outcomes.set(built.id, built.outcome);
        continue;
      }

      if (pair && pair.chunk.toolName === "web_search") {
        const built = rebuildWebSearchOutcome(pair.chunk, result, ctxFor(pair));
        pending.delete(result.toolCallId);
        if (built) outcomes.set(built.id, built.outcome);
        continue;
      }

      const ctx: RebuildContext = pair
        ? ctxFor(pair)
        : {
            threadId,
            runId: row.runId,
            entityId,
            ts: eventTs,
            log,
          };
      const imageOutcome = rebuildImageOutcome(pair?.chunk, result, ctx);
      if (imageOutcome) {
        outcomes.set(imageOutcome.id, imageOutcome.outcome);
        if (pair) pending.delete(result.toolCallId);
      }
    } else if (row.eventType === "activity_snapshot") {
      const p = row.payload as {
        messageId?: unknown;
        activityType?: unknown;
        content?: unknown;
      };
      if (
        typeof p.messageId === "string" &&
        p.activityType === GENERATIVE_UI_ACTIVITY_TYPE &&
        p.content &&
        typeof p.content === "object" &&
        !Array.isArray(p.content)
      ) {
        surfaceDrafts.set(p.messageId, {
          raw: { ...(p.content as Record<string, unknown>) },
          runId: row.runId,
          entityId,
          ts: eventTs,
        });
      }
    } else if (row.eventType === "activity_delta") {
      const p = row.payload as {
        messageId?: unknown;
        activityType?: unknown;
        patch?: unknown;
      };
      if (
        typeof p.messageId === "string" &&
        p.activityType === GENERATIVE_UI_ACTIVITY_TYPE &&
        Array.isArray(p.patch)
      ) {
        const existing = surfaceDrafts.get(p.messageId);
        if (existing) {
          existing.raw = applySurfaceDelta(
            existing.raw,
            p.patch as SurfacePatchOp[],
          );
          existing.ts = eventTs;
        }
      }
    }
  }

  for (const draft of surfaceDrafts.values()) {
    const built = rebuildA2UiOutcome(draft.raw, {
      threadId,
      runId: draft.runId,
      entityId: draft.entityId,
      ts: draft.ts,
      log,
    });
    if (built) outcomes.set(built.id, built.outcome);
  }

  return outcomes;
}
