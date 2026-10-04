import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MockDrizzleDb } from "tests/unit/helpers";

const { getSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/db", async () => {
  const { createDrizzleMock } = await import("tests/unit/helpers");
  return { db: createDrizzleMock() };
});

import { db } from "@/lib/db";
const drizzleMock = db as unknown as MockDrizzleDb;

const mockRuns = [
  {
    id: "run-1",
    parentRunId: null,
    threadId: "trace-123",
    initiator: "user",
    entityId: "agent-1",
    entityKind: "builtin_agent",
    entitySource: "builtin",
    credentialId: null,
    builtinName: "TestAgent",
    credentialName: null,
    mode: "sync",
    status: "succeeded",
    inputTask: "Hello task",
    errorMessage: null,
    ownerId: "user-1",
    ownerEmail: "user@example.com",
    ownerName: "User",
    startedAt: "2026-10-04T12:00:00.000Z",
    finishedAt: "2026-10-04T12:00:05.000Z",
    createdAt: "2026-10-04T12:00:00.000Z",
  },
  {
    id: "run-2",
    parentRunId: "run-1",
    threadId: "trace-123",
    initiator: "agent",
    entityId: "agent-2",
    entityKind: "builtin_agent",
    entitySource: "builtin",
    credentialId: null,
    builtinName: "SubAgent",
    credentialName: null,
    mode: "sync",
    status: "failed",
    inputTask: "Sub task",
    errorMessage: "Tool execution failed",
    ownerId: "user-1",
    ownerEmail: "user@example.com",
    ownerName: "User",
    startedAt: "2026-10-04T12:00:01.000Z",
    finishedAt: "2026-10-04T12:00:04.000Z",
    createdAt: "2026-10-04T12:00:01.000Z",
  },
];

const mockToolEvents = [
  // Run 1 tool call 1: succeeded
  {
    runId: "run-1",
    seq: 1,
    type: "tool_call_chunk",
    ts: "2026-10-04T12:00:01.000Z",
    payload: { toolCallId: "call-1", toolName: "calculator" },
  },
  {
    runId: "run-1",
    seq: 2,
    type: "tool_call_result",
    ts: "2026-10-04T12:00:02.000Z",
    payload: { toolCallId: "call-1", content: "42" },
  },
  // Run 2 tool call 2: failed
  {
    runId: "run-2",
    seq: 1,
    type: "tool_call_chunk",
    ts: "2026-10-04T12:00:02.000Z",
    payload: { toolCallId: "call-2", toolName: "search" },
  },
  {
    runId: "run-2",
    seq: 2,
    type: "tool_call_result",
    ts: "2026-10-04T12:00:03.000Z",
    payload: { toolCallId: "call-2", content: JSON.stringify({ isError: true, message: "Network timeout" }) },
  },
];

import { GET } from "@/app/api/trace/[id]/route";
import { createMockRequest } from "tests/unit/helpers";
import { EDITOR_USER, createMockSession } from "tests/unit/fixtures";

describe("GET /api/trace/[id] — Tool Failures and Summary Metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drizzleMock.$reset();
    getSessionMock.mockResolvedValue(
      createMockSession({ ...EDITOR_USER, id: "user-1" }),
    );
  });

  it("computes totalToolCalls and failedToolCalls across runs correctly", async () => {
    // Queue 1: runs query
    // Queue 2: ttft query
    // Queue 3: toolEvents query
    drizzleMock.$enqueue(
      mockRuns,
      [{ runId: "run-1", ttftMs: 500 }],
      mockToolEvents,
    );

    const req = createMockRequest("/api/trace/trace-123", { method: "GET" });
    const res = await GET(req, {
      params: Promise.resolve({ id: "trace-123" }),
    });

    const body = await res.json();
    expect(res.status).toBe(200);

    expect(body.threadId).toBe("trace-123");
    expect(body.summary).toBeDefined();
    expect(body.summary.topLevelRunCount).toBe(1);
    expect(body.summary.subRunCount).toBe(1);
    expect(body.summary.totalToolCalls).toBe(2);
    expect(body.summary.failedToolCalls).toBe(1);
    expect(body.summary.worstStatus).toBe("failed");
  });
});
