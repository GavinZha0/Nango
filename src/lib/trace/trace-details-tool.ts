import "server-only";

import { z } from "zod";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  EntityRunTable,
  EntityRunEventTable,
  BuiltinAgentTable,
  CredentialTable,
} from "@/lib/db/schema";
import { defineTool, type ToolDefinition } from "@/lib/copilot/index.server";
import { detectToolResultStatus } from "@/lib/copilot/detect-tool-result-status";
import {
  durationMsBetween,
  pickWorstStatus,
} from "@/lib/runner/thread-metrics";
import { aggregateToolCalls } from "@/lib/runner/tool-call-aggregator";

export interface TraceDetailsToolContext {
  userId: string;
  isAdmin?: boolean;
}

export const getTraceDetailsSchema = z.object({
  traceId: z
    .string()
    .uuid()
    .describe("The trace thread ID to inspect. Usually obtained from activeResourceData.traceId."),
  run: z
    .union([z.number().int().positive(), z.string()])
    .optional()
    .describe(
      "Optional run filter. Pass a 1-based turn number (e.g. 1 for 1st turn/question, 2 for 2nd) or a run UUID. If omitted, returns all runs in the trace.",
    ),
  runId: z
    .string()
    .uuid()
    .optional()
    .describe("Deprecated alias for run UUID. Prefer using `run`."),
  role: z
    .enum(["user", "assistant", "tool", "all"])
    .default("all")
    .optional()
    .describe(
      "Optional role filter to trim down token usage. 'user': only user prompts (inputTask); 'assistant': only assistant responses (outputSummary); 'tool': only tool calls; 'all': complete details. Defaults to 'all'.",
    ),
  includeToolResults: z
    .boolean()
    .optional()
    .describe(
      "Whether to include tool execution result snippets. Defaults to true when a single run is filtered, false when querying all runs to avoid giant token payload.",
    ),
});

export function buildTraceDetailsTool(ctx: TraceDetailsToolContext): ToolDefinition {
  return defineTool({
    name: "get_trace_details",
    description: [
      "Retrieve detailed execution forensics, multi-run trees, tool call inputs/outputs, and failure causes for a specific trace.",
      "Supports filtering by `run` (e.g. 1 for 1st turn, 2 for 2nd) and `role` ('user' | 'assistant' | 'tool' | 'all') to dramatically reduce token payload.",
      "Use this tool when diagnosing execution errors, evaluating performance bottlenecks, or extracting user interaction turns and tool expectations to author evaluation test cases.",
    ].join(" "),
    parameters: getTraceDetailsSchema,
    execute: async ({
      traceId,
      run,
      runId,
      role = "all",
      includeToolResults,
    }) => {
      // Step 1: Query runs belonging to this trace
      const runs = await db
        .select({
          id: EntityRunTable.id,
          parentRunId: EntityRunTable.parentRunId,
          threadId: EntityRunTable.threadId,
          initiator: EntityRunTable.initiator,
          entityId: EntityRunTable.entityId,
          entityKind: EntityRunTable.entityKind,
          entitySource: EntityRunTable.entitySource,
          builtinName: BuiltinAgentTable.name,
          credentialName: CredentialTable.name,
          mode: EntityRunTable.mode,
          status: EntityRunTable.status,
          inputTask: EntityRunTable.inputTask,
          outputSummary: EntityRunTable.outputSummary,
          errorMessage: EntityRunTable.errorMessage,
          errorDetails: EntityRunTable.errorDetails,
          ownerId: EntityRunTable.ownerId,
          startedAt: EntityRunTable.startedAt,
          finishedAt: EntityRunTable.finishedAt,
          createdAt: EntityRunTable.createdAt,
        })
        .from(EntityRunTable)
        .leftJoin(
          BuiltinAgentTable,
          sql`${EntityRunTable.entityId} = ${BuiltinAgentTable.id}::text`,
        )
        .leftJoin(
          CredentialTable,
          eq(EntityRunTable.credentialId, CredentialTable.id),
        )
        .where(
          and(
            eq(EntityRunTable.threadId, traceId),
            ctx.isAdmin ? undefined : eq(EntityRunTable.ownerId, ctx.userId),
          ),
        )
        .orderBy(asc(EntityRunTable.createdAt));

      if (runs.length === 0) {
        return {
          isError: true,
          message: `Trace '${traceId}' not found or access denied.`,
        };
      }

      const topLevelRuns = runs.filter((r) => r.parentRunId === null);
      const targetAgentName =
        topLevelRuns[0]?.builtinName ??
        topLevelRuns[0]?.credentialName ??
        topLevelRuns[0]?.entityId;

      const runIndexMap = new Map<string, number>();
      topLevelRuns.forEach((r, idx) => {
        runIndexMap.set(r.id, idx + 1);
      });

      const subRunCounter = new Map<string, number>();
      const subRunIndexMap = new Map<string, number>();

      runs.forEach((r) => {
        if (r.parentRunId && runIndexMap.has(r.parentRunId)) {
          runIndexMap.set(r.id, runIndexMap.get(r.parentRunId)!);
          const currentCount = (subRunCounter.get(r.parentRunId) ?? 0) + 1;
          subRunCounter.set(r.parentRunId, currentCount);
          subRunIndexMap.set(r.id, currentCount);
        }
      });

      // Filter to specific run if requested
      const rawTarget = run ?? runId;
      let scopedRuns = runs;
      let isSingleRunQuery = false;

      if (rawTarget !== undefined && rawTarget !== null && rawTarget !== "") {
        isSingleRunQuery = true;
        let matchedIndex: number | null = null;
        let matchedRunId: string | null = null;

        if (typeof rawTarget === "number") {
          matchedIndex = rawTarget;
        } else {
          const trimmed = rawTarget.trim();
          if (/^\d+$/.test(trimmed)) {
            matchedIndex = parseInt(trimmed, 10);
          } else {
            matchedRunId = trimmed;
          }
        }

        if (matchedIndex !== null) {
          if (matchedIndex < 1 || matchedIndex > topLevelRuns.length) {
            return {
              isError: true,
              message: `Turn index #${matchedIndex} not found in trace '${traceId}'. Available top-level turns: 1 to ${topLevelRuns.length}.`,
            };
          }
          const rootRun = topLevelRuns[matchedIndex - 1];
          scopedRuns = runs.filter(
            (r) => r.id === rootRun.id || r.parentRunId === rootRun.id,
          );
        } else if (matchedRunId !== null) {
          const directMatch = runs.find((r) => r.id === matchedRunId);
          if (!directMatch) {
            return {
              isError: true,
              message: `Run '${matchedRunId}' not found in trace '${traceId}'.`,
            };
          }
          scopedRuns = runs.filter(
            (r) => r.id === matchedRunId || r.parentRunId === matchedRunId,
          );
        }
      }

      const runIds = scopedRuns.map((r) => r.id);
      const shouldIncludeToolResults = includeToolResults ?? isSingleRunQuery;
      const needToolCalls = role === "all" || role === "tool";

      // Step 2: Fetch and aggregate tool calls only when needed
      let toolCallsByRun = new Map<string, ReturnType<typeof aggregateToolCalls> extends Map<string, infer V> ? V : never>();
      if (needToolCalls) {
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

        toolCallsByRun = aggregateToolCalls(toolEvents);
      }

      const allStatuses = scopedRuns.map((r) => r.status);
      const worstStatus = pickWorstStatus(allStatuses);
      const cumulativeDurationMs = topLevelRuns.reduce(
        (acc, r) => acc + (durationMsBetween(r.startedAt, r.finishedAt) ?? 0),
        0,
      );

      let totalToolCallsCount = 0;
      let failedToolCallsCount = 0;

      const formattedRuns = scopedRuns.map((r) => {
        const turnIndex = runIndexMap.get(r.id) ?? 1;
        const subRunIndex = subRunIndexMap.get(r.id);
        const isTopLevel = r.parentRunId === null;
        const currentAgentName = r.builtinName ?? r.credentialName ?? r.entityId;
        const isDelegate = !isTopLevel && currentAgentName !== targetAgentName;

        const baseIdentification = {
          turn: turnIndex,
          ...(subRunIndex ? { subRun: subRunIndex } : {}),
          ...(isDelegate ? { delegateAgent: currentAgentName } : {}),
        };

        if (role === "user") {
          return {
            ...baseIdentification,
            initiator: r.initiator,
            inputTask: r.inputTask,
            startedAt: r.startedAt ?? r.createdAt,
          };
        }

        if (role === "assistant") {
          return {
            ...baseIdentification,
            status: r.status,
            outputSummary: r.outputSummary,
            errorMessage: r.errorMessage,
            durationMs: durationMsBetween(r.startedAt, r.finishedAt),
          };
        }

        const perRunToolCalls = toolCallsByRun.get(r.id) ?? [];
        totalToolCallsCount += perRunToolCalls.length;

        const mappedToolCalls = perRunToolCalls.map((tc) => {
          let status: "success" | "failure" | "warning" | "pending";
          if (tc.endedAt === null) {
            status = "pending";
          } else {
            status = detectToolResultStatus(tc.resultContent) ?? "success";
          }
          if (status === "failure") {
            failedToolCallsCount++;
          }

          let snippet: string | null = null;
          if (shouldIncludeToolResults && tc.resultContent) {
            snippet =
              tc.resultContent.length > 500
                ? `${tc.resultContent.slice(0, 500)}…`
                : tc.resultContent;
          }

          return {
            toolName: tc.toolName,
            status,
            durationMs: durationMsBetween(tc.startedAt, tc.endedAt),
            ...(shouldIncludeToolResults ? { resultSnippet: snippet } : {}),
          };
        });

        if (role === "tool") {
          return {
            ...baseIdentification,
            status: r.status,
            toolCalls: mappedToolCalls,
          };
        }

        // role === "all"
        return {
          ...baseIdentification,
          status: r.status,
          inputTask: r.inputTask,
          outputSummary: r.outputSummary,
          errorMessage: r.errorMessage,
          errorDetails: isSingleRunQuery
            ? r.errorDetails
            : r.status === "failed"
              ? r.errorDetails
              : null,
          durationMs: durationMsBetween(r.startedAt, r.finishedAt),
          toolCalls: mappedToolCalls,
        };
      });

      return {
        traceId,
        role,
        summary: {
          status: worstStatus,
          totalRuns: runs.length,
          topLevelTurns: topLevelRuns.length,
          scopedRunsCount: scopedRuns.length,
          cumulativeDurationMs,
          totalToolCalls: totalToolCallsCount,
          failedToolCalls: failedToolCallsCount,
        },
        runs: formattedRuns,
      };
    },
  });
}
