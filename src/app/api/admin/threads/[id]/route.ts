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
 * GET /api/admin/threads/[id]
 *
 * Returns the full structure for the thread detail page:
 *   - `summary`: thread-level aggregates (counts, TTFT avg, total compute)
 *   - `runs`:    every run in the thread (top-level + sub) with per-run
 *               metrics inlined; the client builds the timeline + sub-run
 *               tree by walking `parentRunId`.
 *
 * Per-run metrics:
 *   - `ttftMs`:        first user-visible assistant `message` event timestamp
 *                     minus `startedAt`. `null` when the run produced no
 *                     assistant text (pure tool-only runs, never-started
 *                     runs, etc.).
 *   - `durationMs`:    `finishedAt - startedAt`, `null` while running.
 *   - `toolCalls`:     one entry per distinct `toolCallId`, paired between
 *                     the `tool_call_chunk` start and the matching
 *                     `tool_call_result` end. Classification via
 *                     {@link detectToolResultStatus}.
 *   - `subRunCount`:   computed in TypeScript from the run-list itself.
 *
 * Events are NOT inlined — the right column lazily fetches them via the
 * existing `/api/admin/runs/[id]` endpoint when the admin selects a run.
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
  // Step 2 — TTFT per run.
  //
  // (first user-visible LLM event ts) − (entity_run.started_at),
  // computed ENTIRELY IN SQL via `EXTRACT(EPOCH FROM …)` — same idiom
  // as the cumulative-duration aggregate above.
  //
  // "First user-visible LLM event" is the earliest of:
  //   - `message` with `payload.role = 'assistant'`  (assistant text)
  //   - `reasoning`                                  (o1/o3-style trace)
  //   - `tool_call_chunk`                            (LLM decided to call a tool)
  //
  // We include tool_call_chunk because from the chat UI's perspective
  // a tool-call card IS the first visible response — so a run that
  // only ever calls a tool (no assistant text) still has a meaningful
  // TTFT. Caveat: PersistingAgent flushes tool_call_chunk rows at
  // TOOL_CALL_END (after the args have fully streamed), so the TTFT
  // for tool-only runs is slightly inflated by the args-streaming
  // window. Accepted trade-off — args streaming is typically << LLM
  // reasoning time, and "always a number" is more useful than
  // "exact but often null". A future schema bump could persist
  // tool_call_start to recover the precision.
  //
  // QUIRK: TTFT used to be computed in TypeScript as `new Date(a) -
  // new Date(b)`, but `entity_run.started_at` and
  // `entity_run_event.ts` are both `timestamp without time zone`. The
  // drizzle column reader and the raw-SQL `MIN(ts)` path parse those
  // bare timestamps through different paths and (depending on the
  // driver / process timezone) end up at Date objects that disagree
  // by exactly the session timezone offset — producing the famous
  // "TTFT shows 4h on every run" symptom. Doing the subtraction
  // inside Postgres uses pure timestamp arithmetic, so the offset
  // can't sneak in.
  //
  // NULL when the run produced no qualifying event — perfectly valid
  // for runs that errored before any output.
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
  // Step 3 — Tool call timings, paired across runs by toolCallId.
  //
  // chunk and result for the SAME toolCallId may live in different
  // entity_run rows (frontend / HITL tools: the LLM emits chunk in
  // run X, user reply arrives as a result event in run X+1; see
  // `docs/runner-events.md` §4.5). Aggregating across the whole
  // thread lets us:
  //
  //   - render a single tool row per toolCallId on whichever run it
  //     was DECIDED in (the chunk-bearing run), with a real
  //     `durationMs` even when the result lives in a continuation
  //     run.
  //   - keep `pending` (amber) reserved for actually-unpaired chunks
  //     (agent died, bridge dropped the result, ...) instead of
  //     false-flagging every frontend-tool turn.
  //   - keep continuation runs' RunCards clean — the result event is
  //     still in the timeline but does NOT spawn a half-empty tool
  //     row on the continuation card.
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

    // TTFT was computed in SQL (Step 2) so we sidestep the timestamp-
    // without-time-zone parsing-path discrepancy. Map miss → null,
    // which is the right signal for runs without any assistant text.
    const ttftRaw = ttftByRun.get(r.id);
    const ttftMs =
      ttftRaw !== undefined && Number.isFinite(ttftRaw) && ttftRaw >= 0
        ? Math.round(ttftRaw)
        : null;

    const perRunToolCalls = toolCallsByRun.get(r.id) ?? [];
    const toolCalls: ToolCallSummary[] = perRunToolCalls.map((tc) => {
      let status: ToolCallSummary["status"];
      if (tc.endedAt === null) {
        // No result anywhere in the thread — true dangling chunk
        // (agent crashed, bridge dropped result, ...). amber.
        status = "pending";
      } else {
        const detected = detectToolResultStatus(tc.resultContent);
        status = detected ?? "success";
      }
      return {
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        // startedAt should always be present once the chunk row
        // landed; fall back to the result ts for the (rare) case
        // where only a result row survives.
        startedAt: tc.startedAt ?? tc.endedAt ?? createdAt,
        endedAt: tc.endedAt,
        // Duration spans the chunk-emit → result-emit interval. For
        // a frontend / HITL tool the result lives in the next run
        // and includes user think time — that's the honest answer
        // to "how long did this tool take from the LLM's POV".
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
