import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MockDrizzleDb } from "tests/unit/helpers";

vi.mock("@/lib/db", async () => {
  const { createDrizzleMock } = await import("tests/unit/helpers");
  return { db: createDrizzleMock() };
});

import { db } from "@/lib/db";
const drizzleMock = db as unknown as MockDrizzleDb;

import { buildTraceDetailsTool } from "@/lib/trace/trace-details-tool";

interface TraceToolResult {
  [key: string]: unknown;
  isError?: boolean;
  message?: string;
  traceId?: string;
  role?: string;
  summary?: {
    totalRuns: number;
    topLevelTurns: number;
    totalToolCalls: number;
    failedToolCalls: number;
    status: string;
    scopedRunsCount: number;
  };
  runs?: Array<{
    [key: string]: unknown;
    turn?: number;
    subRun?: number;
    delegateAgent?: string;
    inputTask?: string;
    outputSummary?: string | null;
    status?: string;
    errorMessage?: string | null;
    errorDetails?: unknown;
    toolCalls?: Array<{
      toolName: string;
      status: string;
      resultSnippet?: string | null;
    }>;
    id?: string;
    parentRunId?: string | null;
    agent?: unknown;
  }>;
}

type ExecuteFn = (args: Record<string, unknown>) => Promise<TraceToolResult>;

const mockRuns = [
  {
    id: "run-top-1",
    parentRunId: null,
    threadId: "trace-abc-123",
    initiator: "user",
    entityId: "agent-1",
    entityKind: "builtin_agent",
    entitySource: "builtin",
    builtinName: "FinanceAssistant",
    credentialName: null,
    mode: "sync",
    status: "succeeded",
    inputTask: "Query revenue data",
    outputSummary: "Total revenue is 500k",
    errorMessage: null,
    errorDetails: null,
    ownerId: "user-1",
    startedAt: "2026-10-04T12:00:00.000Z",
    finishedAt: "2026-10-04T12:00:05.000Z",
    createdAt: "2026-10-04T12:00:00.000Z",
  },
  {
    id: "run-sub-2",
    parentRunId: "run-top-1",
    threadId: "trace-abc-123",
    initiator: "agent",
    entityId: "agent-2",
    entityKind: "builtin_agent",
    entitySource: "builtin",
    builtinName: "SqlAgent",
    credentialName: null,
    mode: "sync",
    status: "failed",
    inputTask: "Execute SQL",
    outputSummary: null,
    errorMessage: "Database connection failed",
    errorDetails: { code: "ECONNREFUSED" },
    ownerId: "user-1",
    startedAt: "2026-10-04T12:00:01.000Z",
    finishedAt: "2026-10-04T12:00:03.000Z",
    createdAt: "2026-10-04T12:00:01.000Z",
  },
];

const mockToolEvents = [
  {
    runId: "run-top-1",
    seq: 1,
    type: "tool_call_chunk",
    ts: "2026-10-04T12:00:01.000Z",
    payload: { toolCallId: "call-1", toolName: "delegate_to_agent" },
  },
  {
    runId: "run-top-1",
    seq: 2,
    type: "tool_call_result",
    ts: "2026-10-04T12:00:04.000Z",
    payload: { toolCallId: "call-1", content: JSON.stringify({ ok: true }) },
  },
  {
    runId: "run-sub-2",
    seq: 1,
    type: "tool_call_chunk",
    ts: "2026-10-04T12:00:01.500Z",
    payload: { toolCallId: "call-2", toolName: "sql_query" },
  },
  {
    runId: "run-sub-2",
    seq: 2,
    type: "tool_call_result",
    ts: "2026-10-04T12:00:02.500Z",
    payload: { toolCallId: "call-2", content: JSON.stringify({ isError: true, message: "Connection refused" }) },
  },
];

describe("get_trace_details tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drizzleMock.$reset();
  });

  it("returns error when trace is not found or not owned by user", async () => {
    drizzleMock.$enqueue([]); // No runs found
    const tool = buildTraceDetailsTool({ userId: "user-1" });
    const res = await (tool.execute as ExecuteFn)({ traceId: "018f3a55-0000-7000-8000-000000000001" });

    expect(res.isError).toBe(true);
    expect(res.message).toContain("not found or access denied");
  });

  it("returns clean, token-efficient trace details omitting redundant runId and targetAgent", async () => {
    drizzleMock.$enqueue(mockRuns, mockToolEvents);

    const tool = buildTraceDetailsTool({ userId: "user-1" });
    const res = await (tool.execute as ExecuteFn)({ traceId: "018f3a55-0000-7000-8000-000000000001" });

    expect(res.isError).toBeUndefined();
    expect(res.traceId).toBe("018f3a55-0000-7000-8000-000000000001");
    expect(res.role).toBe("all");
    expect(res.summary).toBeDefined();
    expect(res.summary!.totalRuns).toBe(2);
    expect(res.summary!.topLevelTurns).toBe(1);
    expect(res.summary!.totalToolCalls).toBe(2);
    expect(res.summary!.failedToolCalls).toBe(1);
    expect(res.summary!.status).toBe("failed");

    expect(res.runs).toHaveLength(2);
    const topRun = res.runs![0];
    expect(topRun.turn).toBe(1);
    // UUIDs and redundant agent objects are omitted
    expect(topRun.id).toBeUndefined();
    expect(topRun.parentRunId).toBeUndefined();
    expect(topRun.agent).toBeUndefined();
    expect(topRun.delegateAgent).toBeUndefined();
    expect(topRun.inputTask).toBe("Query revenue data");
    expect(topRun.outputSummary).toBe("Total revenue is 500k");
    expect(topRun.toolCalls).toHaveLength(1);
    expect(topRun.toolCalls![0].toolName).toBe("delegate_to_agent");
    expect(topRun.toolCalls![0].status).toBe("success");
    // In bulk query mode, tool result snippet is omitted to save tokens
    expect(topRun.toolCalls![0].resultSnippet).toBeUndefined();

    const subRun = res.runs![1];
    expect(subRun.turn).toBe(1);
    expect(subRun.subRun).toBe(1);
    expect(subRun.delegateAgent).toBe("SqlAgent");
    expect(subRun.id).toBeUndefined();
    expect(subRun.parentRunId).toBeUndefined();
    expect(subRun.agent).toBeUndefined();
    expect(subRun.status).toBe("failed");
    expect(subRun.errorMessage).toBe("Database connection failed");
    expect(subRun.errorDetails).toEqual({ code: "ECONNREFUSED" });
    expect(subRun.toolCalls).toHaveLength(1);
    expect(subRun.toolCalls![0].status).toBe("failure");
  });

  it("supports scoping by 1-based turn number (run: 1) with detailed tool results", async () => {
    drizzleMock.$enqueue(mockRuns, mockToolEvents);

    const tool = buildTraceDetailsTool({ userId: "user-1" });
    const res = await (tool.execute as ExecuteFn)({
      traceId: "018f3a55-0000-7000-8000-000000000001",
      run: 1,
    });

    expect(res.isError).toBeUndefined();
    expect(res.summary!.scopedRunsCount).toBe(2); // Top run + its sub-run
    expect(res.runs![0].turn).toBe(1);
    expect(res.runs![1].turn).toBe(1);
    expect(res.runs![1].subRun).toBe(1);
    // In single run mode, resultSnippet is included
    expect(res.runs![1].toolCalls![0].resultSnippet).toContain("Connection refused");
  });

  it("returns error for out-of-range run turn number", async () => {
    drizzleMock.$enqueue(mockRuns);

    const tool = buildTraceDetailsTool({ userId: "user-1" });
    const res = await (tool.execute as ExecuteFn)({
      traceId: "018f3a55-0000-7000-8000-000000000001",
      run: 99,
    });

    expect(res.isError).toBe(true);
    expect(res.message).toContain("Turn index #99 not found");
  });

  it("supports filtering by role: 'user' to only return user queries without IDs or toolCalls", async () => {
    drizzleMock.$enqueue(mockRuns);

    const tool = buildTraceDetailsTool({ userId: "user-1" });
    const res = await (tool.execute as ExecuteFn)({
      traceId: "018f3a55-0000-7000-8000-000000000001",
      run: 1,
      role: "user",
    });

    expect(res.isError).toBeUndefined();
    expect(res.role).toBe("user");
    expect(res.runs).toHaveLength(2);
    expect(res.runs![0].turn).toBe(1);
    expect(res.runs![0].inputTask).toBe("Query revenue data");
    expect(res.runs![0].toolCalls).toBeUndefined();
    expect(res.runs![0].outputSummary).toBeUndefined();
    expect(res.runs![0].id).toBeUndefined();
  });

  it("supports filtering by role: 'assistant' to only return agent output", async () => {
    drizzleMock.$enqueue(mockRuns);

    const tool = buildTraceDetailsTool({ userId: "user-1" });
    const res = await (tool.execute as ExecuteFn)({
      traceId: "018f3a55-0000-7000-8000-000000000001",
      role: "assistant",
    });

    expect(res.isError).toBeUndefined();
    expect(res.role).toBe("assistant");
    expect(res.runs![0].outputSummary).toBe("Total revenue is 500k");
    expect(res.runs![0].inputTask).toBeUndefined();
    expect(res.runs![0].toolCalls).toBeUndefined();
  });

  it("supports filtering by role: 'tool' to only return tool calls", async () => {
    drizzleMock.$enqueue(mockRuns, mockToolEvents);

    const tool = buildTraceDetailsTool({ userId: "user-1" });
    const res = await (tool.execute as ExecuteFn)({
      traceId: "018f3a55-0000-7000-8000-000000000001",
      role: "tool",
    });

    expect(res.isError).toBeUndefined();
    expect(res.role).toBe("tool");
    expect(res.runs![0].toolCalls).toHaveLength(1);
    expect(res.runs![0].inputTask).toBeUndefined();
    expect(res.runs![0].outputSummary).toBeUndefined();
  });

  it("supports scoping to a specific runId string", async () => {
    drizzleMock.$enqueue(mockRuns, mockToolEvents);

    const tool = buildTraceDetailsTool({ userId: "user-1" });
    const res = await (tool.execute as ExecuteFn)({
      traceId: "018f3a55-0000-7000-8000-000000000001",
      runId: "run-sub-2",
    });

    expect(res.isError).toBeUndefined();
    expect(res.summary!.scopedRunsCount).toBe(1);
    expect(res.runs).toHaveLength(1);
    expect(res.runs![0].turn).toBe(1);
    expect(res.runs![0].subRun).toBe(1);
    expect(res.runs![0].delegateAgent).toBe("SqlAgent");
  });
});
