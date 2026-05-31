import "server-only";

import { NextResponse } from "next/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  BuiltinAgentTable,
  CredentialTable,
  EntityRunEventTable,
  EntityRunTable,
  UserTable,
} from "@/lib/db/schema";
import { detectToolResultStatus } from "@/lib/copilot/detect-tool-result-status";
import { ApiError, withAdmin } from "@/lib/http/route-handlers";
import {
  durationMsBetween,
  pickWorstStatus,
} from "@/lib/runner/thread-metrics";
import { aggregateToolCalls } from "@/lib/runner/tool-call-aggregator";

/**
 * GET /api/admin/threads/[id] — thread-detail payload for the
 * admin page. Returns `{ summary, runs[] }` with per-run metrics
 * (`ttftMs`, `durationMs`, `toolCalls`, `subRunCount`) inlined.
 * Events are NOT included — the right column lazily fetches them
 * via `/api/admin/runs/[id]` on selection.
 */

const ROUTE = "/api/admin/threads/[id]";

interface ToolCallSummary {
  toolCallId: string;
  toolName: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: "success" | "failure" | "warning" | "pending";
}

interface RunMetrics {
  ttftMs: number | null;
  durationMs: number | null;
  toolCalls: ReadonlyArray<ToolCallSummary>;
  subRunCount: number;
}

interface RunWithMetrics {
  id: string;
  parentRunId: string | null;
  threadId: string | null;
  initiator: string;
  entityId: string;
  entityKind: string;
  entitySource: string;
  credentialId: string | null;
  builtinName: string | null;
  credentialName: string | null;
  mode: string;
  status: string;
  inputTask: string;
  errorMessage: string | null;
  ownerId: string;
  ownerEmail: string | null;
  ownerName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  metrics: RunMetrics;
}

interface ThreadSummary {
  threadId: string;
  ownerId: string;
  ownerEmail: string | null;
  ownerName: string | null;
  firstRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  topLevelRunCount: number;
  subRunCount: number;
  cumulativeDurationMs: number;
  avgTtftMs: number | null;
  failedCount: number;
  worstStatus: string;
}

interface ThreadDetailResponse {
  threadId: string;
  summary: ThreadSummary;
  runs: ReadonlyArray<RunWithMetrics>;
}

export const GET = withAdmin<{ id: string }>(ROUTE, async ({ params }) => {
  const threadId = params.id;

  // ------------------------------------------------------------------
  // Step 1 — All runs in this thread (top-level + sub).
  // ------------------------------------------------------------------
  const runs = await db
    .select({
      id: EntityRunTable.id,
      parentRunId: EntityRunTable.parentRunId,
      threadId: EntityRunTable.threadId,
      initiator: EntityRunTable.initiator,
      entityId: EntityRunTable.entityId,
      entityKind: EntityRunTable.entityKind,
      entitySource: EntityRunTable.entitySource,
      credentialId: EntityRunTable.credentialId,
      builtinName: BuiltinAgentTable.name,
      credentialName: CredentialTable.name,
      mode: EntityRunTable.mode,
      status: EntityRunTable.status,
      inputTask: EntityRunTable.inputTask,
      errorMessage: EntityRunTable.errorMessage,
      ownerId: EntityRunTable.ownerId,
      ownerEmail: UserTable.email,
      ownerName: UserTable.name,
      startedAt: EntityRunTable.startedAt,
      finishedAt: EntityRunTable.finishedAt,
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
    .where(eq(EntityRunTable.threadId, threadId))
    .orderBy(asc(EntityRunTable.createdAt));

  if (runs.length === 0) {
    throw new ApiError(
      "NOT_FOUND",
      404,
      "Thread not found or has no runs.",
    );
  }

  const runIds = runs.map((r) => r.id);

  // ------------------------------------------------------------------
  // Step 2 — TTFT per run: `MIN(event.ts) - run.started_at` over the
  // first user-visible LLM event (assistant message, reasoning, or
  // `tool_call_chunk` — tool-only runs need a meaningful TTFT too).
  //
  // GOTCHA: arithmetic MUST happen inside Postgres. `entity_run` and
  // `entity_run_event` both use `timestamp without time zone`; the
  // drizzle column reader and the raw-SQL aggregate parse those
  // through different paths and (depending on TZ) disagree by the
  // session offset, producing the "TTFT shows 4h on every run" bug.
  // ------------------------------------------------------------------
  const ttftRows = await db
    .select({
      runId: EntityRunEventTable.runId,
      ttftMs: sql<number>`
        EXTRACT(
          EPOCH FROM (
            MIN(${EntityRunEventTable.ts})
            - MAX(${EntityRunTable.startedAt})
          )
        )::numeric * 1000
      `.mapWith(Number),
    })
    .from(EntityRunEventTable)
    .innerJoin(
      EntityRunTable,
      eq(EntityRunEventTable.runId, EntityRunTable.id),
    )
    .where(
      and(
        inArray(EntityRunEventTable.runId, runIds),
        sql`(
          (${EntityRunEventTable.type} = 'message'
            AND ${EntityRunEventTable.payload}->>'role' = 'assistant')
          OR ${EntityRunEventTable.type} = 'reasoning'
          OR ${EntityRunEventTable.type} = 'tool_call_chunk'
        )`,
      ),
    )
    .groupBy(EntityRunEventTable.runId);

  const ttftByRun = new Map(ttftRows.map((r) => [r.runId, r.ttftMs]));

  // ------------------------------------------------------------------
  // Step 3 — Tool-call timings, paired across runs by toolCallId.
  // chunk and result can live in different runs (frontend / HITL
  // tools — chunk in run X, user reply in run X+1). Cross-run
  // aggregation keeps `durationMs` real and reserves "pending" for
  // actually-orphaned chunks. See docs/runner-events.md.
  // ------------------------------------------------------------------
  const toolEvents = await db
    .select({
      runId: EntityRunEventTable.runId,
      seq: EntityRunEventTable.seq,
      type: EntityRunEventTable.type,
      ts: EntityRunEventTable.ts,
      payload: EntityRunEventTable.payload,
    })
    .from(EntityRunEventTable)
    .where(
      and(
        inArray(EntityRunEventTable.runId, runIds),
        inArray(EntityRunEventTable.type, [
          "tool_call_chunk",
          "tool_call_result",
        ]),
      ),
    )
    .orderBy(asc(EntityRunEventTable.ts));

  const toolCallsByRun = aggregateToolCalls(toolEvents);

  // ------------------------------------------------------------------
  // Step 4 — Compose per-run metrics and the response shape.
  // ------------------------------------------------------------------
  const subRunCountByParent = new Map<string, number>();
  for (const r of runs) {
    if (r.parentRunId) {
      subRunCountByParent.set(
        r.parentRunId,
        (subRunCountByParent.get(r.parentRunId) ?? 0) + 1,
      );
    }
  }

  const runsWithMetrics: RunWithMetrics[] = runs.map((r) => {
    const startedAt = r.startedAt ? new Date(r.startedAt).toISOString() : null;
    const finishedAt = r.finishedAt
      ? new Date(r.finishedAt).toISOString()
      : null;
    const createdAt = new Date(r.createdAt).toISOString();

    // Map miss → null (run produced no qualifying event).
    const ttftRaw = ttftByRun.get(r.id);
    const ttftMs =
      ttftRaw !== undefined && Number.isFinite(ttftRaw) && ttftRaw >= 0
        ? Math.round(ttftRaw)
        : null;

    const perRunToolCalls = toolCallsByRun.get(r.id) ?? [];
    const toolCalls: ToolCallSummary[] = perRunToolCalls.map((tc) => {
      let status: ToolCallSummary["status"];
      if (tc.endedAt === null) {
        // Truly orphaned chunk (no result anywhere) — amber.
        status = "pending";
      } else {
        const detected = detectToolResultStatus(tc.resultContent);
        status = detected ?? "success";
      }
      return {
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        // Fall back to endedAt for the rare "result row only" shape.
        startedAt: tc.startedAt ?? tc.endedAt ?? createdAt,
        endedAt: tc.endedAt,
        // chunk → result interval — for HITL tools this honestly
        // includes user think time.
        durationMs: durationMsBetween(tc.startedAt, tc.endedAt),
        status,
      };
    });

    return {
      id: r.id,
      parentRunId: r.parentRunId,
      threadId: r.threadId,
      initiator: r.initiator,
      entityId: r.entityId,
      entityKind: r.entityKind,
      entitySource: r.entitySource,
      credentialId: r.credentialId,
      builtinName: r.builtinName,
      credentialName: r.credentialName,
      mode: r.mode,
      status: r.status,
      inputTask: r.inputTask,
      errorMessage: r.errorMessage,
      ownerId: r.ownerId,
      ownerEmail: r.ownerEmail,
      ownerName: r.ownerName,
      startedAt,
      finishedAt,
      createdAt,
      metrics: {
        ttftMs,
        durationMs: durationMsBetween(r.startedAt, r.finishedAt),
        toolCalls,
        subRunCount: subRunCountByParent.get(r.id) ?? 0,
      },
    };
  });

  // ------------------------------------------------------------------
  // Step 5 — Thread-level summary card metrics.
  // ------------------------------------------------------------------
  const topLevelRuns = runsWithMetrics.filter((r) => r.parentRunId === null);
  const subRuns = runsWithMetrics.filter((r) => r.parentRunId !== null);

  const cumulativeDurationMs = topLevelRuns.reduce(
    (acc, r) => acc + (r.metrics.durationMs ?? 0),
    0,
  );

  // Average TTFT across runs that have one; top-level only since
  // sub-run TTFTs are noise for the admin's "how snappy is the chat"
  // intuition.
  const ttftValues = topLevelRuns
    .map((r) => r.metrics.ttftMs)
    .filter((v): v is number => v !== null);
  const avgTtftMs =
    ttftValues.length > 0
      ? Math.round(
          ttftValues.reduce((a, b) => a + b, 0) / ttftValues.length,
        )
      : null;

  const allStatuses = runsWithMetrics.map((r) => r.status);
  const worstStatus = pickWorstStatus(allStatuses);
  const failedCount = runsWithMetrics.filter(
    (r) => r.status === "failed",
  ).length;

  const startedTimes = runsWithMetrics
    .map((r) => r.startedAt)
    .filter((v): v is string => v !== null);
  const finishedTimes = runsWithMetrics
    .map((r) => r.finishedAt)
    .filter((v): v is string => v !== null);
  const firstRunStartedAt =
    startedTimes.length > 0
      ? startedTimes.reduce((a, b) => (a < b ? a : b))
      : null;
  const lastRunFinishedAt =
    finishedTimes.length > 0
      ? finishedTimes.reduce((a, b) => (a > b ? a : b))
      : null;

  // Owner is single-tenant per thread; lift from the first run.
  const owner = topLevelRuns[0] ?? runsWithMetrics[0];

  const summary: ThreadSummary = {
    threadId,
    ownerId: owner.ownerId,
    ownerEmail: owner.ownerEmail,
    ownerName: owner.ownerName,
    firstRunStartedAt,
    lastRunFinishedAt,
    topLevelRunCount: topLevelRuns.length,
    subRunCount: subRuns.length,
    cumulativeDurationMs,
    avgTtftMs,
    failedCount,
    worstStatus,
  };

  const response: ThreadDetailResponse = {
    threadId,
    summary,
    runs: runsWithMetrics,
  };

  return NextResponse.json(response);
});
