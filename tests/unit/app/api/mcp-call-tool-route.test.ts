/**
 * POST /api/mcp-servers/[id]/call-tool — dual-mode execution matrix.
 *
 * Pins which execution path the route picks for every combination of
 * negotiated protocol era × the tool's declared `execution.taskSupport`,
 * the response envelope of each path, and the session-lifetime rule
 * (a handed-off task's session must NOT be closed, every other path must).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionMock, withMcpAdminClientMock, createTaskSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  withMcpAdminClientMock: vi.fn(),
  createTaskSessionMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({ getSession: getSessionMock }));

vi.mock("@/lib/mcp/admin-client.server", () => ({
  withMcpAdminClient: withMcpAdminClientMock,
}));

vi.mock("@/lib/mcp/tasks-client.server", () => ({
  createTaskSession: createTaskSessionMock,
}));

const mockConfig: Record<string, string> = {};
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  const getConfigNumber = (key: string, defaultValue: number): number => {
    const raw = mockConfig[key];
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : defaultValue;
  };
  return {
    ...actual,
    getConfigNumber,
    getConfigMs: (key: string, defaultSeconds: number) => getConfigNumber(key, defaultSeconds) * 1000,
  };
});

import { ApiError } from "@/lib/http/route-handlers";
import { POST } from "@/app/api/mcp-servers/[id]/call-tool/route";
import { createMockRequest } from "tests/unit/helpers";
import { EDITOR_USER, REGULAR_USER } from "tests/unit/fixtures";

type TaskSupport = "optional" | "required" | "forbidden" | undefined;
type Era = "modern" | "legacy";

const SERVER_ID = "srv-1";
const TOOL = "do_work";
const ARGS = { n: 1 };
const PLAIN_RESULT = { content: [{ type: "text", text: "plain" }] };
const SESSION_RESULT = { content: [{ type: "text", text: "via-session" }] };

interface Harness {
  client: { getProtocolEra: ReturnType<typeof vi.fn>; callTool: ReturnType<typeof vi.fn> };
  session: {
    callTool: ReturnType<typeof vi.fn>;
    task: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  snapshot: ReturnType<typeof vi.fn>;
  handoff: ReturnType<typeof vi.fn>;
}

/**
 * @param serverReturns what the upstream does when called through the
 *   ext-tasks session: answer immediately, or create a task.
 */
function setup(opts: {
  era: Era;
  taskSupport: TaskSupport;
  serverReturns?: "result" | "task";
  tools?: unknown[];
}): Harness {
  const client = {
    getProtocolEra: vi.fn(() => opts.era),
    callTool: vi.fn().mockResolvedValue(PLAIN_RESULT),
  };

  const snapshot = vi.fn().mockResolvedValue({
    taskId: "task-1",
    status: "working",
    pollInterval: 2000,
    raw: { taskId: "task-1", status: "working" },
  });
  const handoff = vi.fn(async (persist: (ref: unknown) => Promise<void>) => {
    await persist({ endpointId: `nango-call-${SERVER_ID}`, taskId: "task-1" });
  });

  const session = {
    callTool: vi.fn().mockResolvedValue(
      opts.serverReturns === "task"
        ? { kind: "task", handle: { taskId: "task-1", operation: "tools/call" }, handoff }
        : { kind: "result", settle: vi.fn().mockResolvedValue({ outcome: { status: "completed", result: SESSION_RESULT } }) },
    ),
    task: vi.fn(() => ({ snapshot })),
    close: vi.fn().mockResolvedValue(undefined),
  };
  createTaskSessionMock.mockReturnValue(session);

  const tools = opts.tools ?? [
    {
      name: TOOL,
      enabled: true,
      ...(opts.taskSupport !== undefined ? { execution: { taskSupport: opts.taskSupport } } : {}),
    },
  ];

  // Mirror the real helper's error mapping: ApiError passes through,
  // anything else becomes 502 "<errorPrefix>: <message>".
  withMcpAdminClientMock.mockImplementation(
    async (o: { errorPrefix: string; fn: (ctx: unknown) => Promise<unknown> }) => {
      try {
        return await o.fn({
          client,
          server: { id: SERVER_ID, tools },
          clientInfo: { name: "nango-tool-call", version: "1.0.0" },
          clientCapabilities: {},
        });
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError("BAD_GATEWAY", 502, `${o.errorPrefix}: ${(err as Error).message}`);
      }
    },
  );

  return { client, session, snapshot, handoff };
}

function call(body: unknown = { toolName: TOOL, args: ARGS }) {
  return POST(
    createMockRequest(`/api/mcp-servers/${SERVER_ID}/call-tool`, { method: "POST", body }),
    { params: Promise.resolve({ id: SERVER_ID }) },
  );
}

function asEditor(): void {
  getSessionMock.mockResolvedValue({
    user: EDITOR_USER,
    session: { id: "sess-1", userId: EDITOR_USER.id },
  });
}

describe("POST /api/mcp-servers/[id]/call-tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(mockConfig)) delete mockConfig[k];
    asEditor();
  });

  describe("path selection matrix", () => {
    it.each<[Era, TaskSupport]>([
      ["legacy", undefined],
      ["legacy", "forbidden"],
    ])("%s + taskSupport=%s → direct client.callTool, no task session", async (era, taskSupport) => {
      const h = setup({ era, taskSupport });

      const res = await call();
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body).toEqual({
        mode: "result",
        result: PLAIN_RESULT,
        snapshotMaxBytes: 32 * 1024,
        pollHistoryLimit: 5,
      });
      expect(h.client.callTool).toHaveBeenCalledWith({ name: TOOL, arguments: ARGS }, { timeout: 60_000 });
      expect(createTaskSessionMock).not.toHaveBeenCalled();
    });

    it.each<[Era, TaskSupport]>([
      ["legacy", "optional"],
      ["legacy", "required"],
      ["modern", undefined],
      ["modern", "forbidden"],
      ["modern", "optional"],
      ["modern", "required"],
    ])("%s + taskSupport=%s, server answers immediately → mode:result via session", async (era, taskSupport) => {
      const h = setup({ era, taskSupport, serverReturns: "result" });

      const res = await call();
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body).toEqual({
        mode: "result",
        result: SESSION_RESULT,
        snapshotMaxBytes: 32 * 1024,
        pollHistoryLimit: 5,
      });
      expect(h.client.callTool).not.toHaveBeenCalled();
      expect(createTaskSessionMock).toHaveBeenCalledWith(
        h.client,
        { name: "nango-tool-call", version: "1.0.0" },
        {},
        `nango-call-${SERVER_ID}`,
      );
      expect(h.session.callTool).toHaveBeenCalledWith(TOOL, ARGS, { requestTimeoutMs: 60_000 });
      expect(h.session.close).toHaveBeenCalledTimes(1);
    });

    it.each<[Era, TaskSupport]>([
      ["legacy", "optional"],
      ["legacy", "required"],
      ["modern", "optional"],
      ["modern", "required"],
    ])("%s + taskSupport=%s, server creates a task → mode:task, session handed off", async (era, taskSupport) => {
      const h = setup({ era, taskSupport, serverReturns: "task" });

      const res = await call();
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body).toEqual({
        mode: "task",
        taskId: "task-1",
        operation: "tools/call",
        initialTask: expect.objectContaining({ taskId: "task-1", status: "working", pollInterval: 2000 }),
        snapshotMaxBytes: 32 * 1024,
        pollHistoryLimit: 5,
      });
      expect(h.session.task).toHaveBeenCalledWith("task-1");
      expect(h.handoff).toHaveBeenCalledTimes(1);
      // Closing the session would cooperatively cancel the live task upstream.
      expect(h.session.close).not.toHaveBeenCalled();
    });
  });

  it("routes through createTaskSession on legacy servers that advertise tasks capability even when tools snapshot is stale", async () => {
    const h = setup({ era: "legacy", taskSupport: undefined, serverReturns: "task" });
    (h.client as unknown as { getServerCapabilities: () => unknown }).getServerCapabilities = () => ({
      tasks: { list: {}, cancel: {} },
    });

    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("task");
    expect(createTaskSessionMock).toHaveBeenCalledTimes(1);
    expect(h.client.callTool).not.toHaveBeenCalled();
  });

  it("treats a tool missing from the discovered snapshot as non-task on legacy servers", async () => {
    const h = setup({ era: "legacy", taskSupport: "required", tools: [{ name: "other", execution: { taskSupport: "required" } }] });

    const body = await (await call()).json();
    expect(body.mode).toBe("result");
    expect(h.client.callTool).toHaveBeenCalled();
    expect(createTaskSessionMock).not.toHaveBeenCalled();
  });

  it("treats a server with no tools snapshot as non-task on legacy servers", async () => {
    const h = setup({ era: "legacy", taskSupport: undefined, tools: undefined });
    withMcpAdminClientMock.mockImplementation(async (o: { fn: (ctx: unknown) => Promise<unknown> }) =>
      o.fn({ client: h.client, server: { id: SERVER_ID, tools: null }, clientInfo: {}, clientCapabilities: {} }),
    );

    const body = await (await call()).json();
    expect(body.mode).toBe("result");
    expect(h.client.callTool).toHaveBeenCalled();
  });

  it("still returns mode:task without initialTask when the initial snapshot fails", async () => {
    const h = setup({ era: "modern", taskSupport: "required", serverReturns: "task" });
    h.snapshot.mockRejectedValue(new Error("tasks/get unsupported"));

    const body = await (await call()).json();
    expect(body).toEqual({
      mode: "task",
      taskId: "task-1",
      operation: "tools/call",
      snapshotMaxBytes: 32 * 1024,
      pollHistoryLimit: 5,
    });
    expect("initialTask" in body).toBe(false);
    expect(h.handoff).toHaveBeenCalledTimes(1);
    expect(h.session.close).not.toHaveBeenCalled();
  });

  it("maps an immediate failed outcome to 502 and closes the session", async () => {
    const h = setup({ era: "modern", taskSupport: undefined });
    h.session.callTool.mockResolvedValue({
      kind: "result",
      settle: vi.fn().mockResolvedValue({ outcome: { status: "failed", error: new Error("upstream exploded") } }),
    });

    const res = await call();
    expect(res.status).toBe(502);
    expect((await res.json()).message).toMatch(/Tool call failed: upstream exploded/);
    expect(h.session.close).toHaveBeenCalledTimes(1);
  });

  it("closes the session when session.callTool itself throws", async () => {
    const h = setup({ era: "modern", taskSupport: undefined });
    h.session.callTool.mockRejectedValue(new Error("transport reset"));

    const res = await call();
    expect(res.status).toBe(502);
    expect(h.session.close).toHaveBeenCalledTimes(1);
  });

  it("normalizes results for the UI (redundant JSON text collapsed when structuredContent exists)", async () => {
    const h = setup({ era: "modern", taskSupport: undefined });
    h.session.callTool.mockResolvedValue({
      kind: "result",
      settle: vi.fn().mockResolvedValue({
        outcome: {
          status: "completed",
          result: { content: [{ type: "text", text: "{\"x\":1}" }], structuredContent: { x: 1 } },
        },
      }),
    });

    const body = await (await call()).json();
    expect(body.result.structuredContent).toEqual({ x: 1 });
    expect(body.result.content[0].text).not.toBe("{\"x\":1}");
  });

  it("honours mcp.execution_timeout, mcp.test_snapshot_max_kb, and mcp.task_poll_history_limit config", async () => {
    mockConfig["mcp.execution_timeout"] = "5";
    mockConfig["mcp.test_snapshot_max_kb"] = "8";
    mockConfig["mcp.task_poll_history_limit"] = "9";
    const h = setup({ era: "modern", taskSupport: undefined });

    const body = await (await call({ toolName: TOOL })).json();
    expect(h.session.callTool).toHaveBeenCalledWith(TOOL, {}, { requestTimeoutMs: 5000 });
    expect(body.snapshotMaxBytes).toBe(8 * 1024);
    expect(body.pollHistoryLimit).toBe(9);
  });

  it("defaults missing args to {} on the direct path", async () => {
    const h = setup({ era: "legacy", taskSupport: undefined });
    await call({ toolName: TOOL });
    expect(h.client.callTool).toHaveBeenCalledWith({ name: TOOL, arguments: {} }, { timeout: 60_000 });
  });

  it("rejects an empty toolName with 400 before connecting", async () => {
    setup({ era: "legacy", taskSupport: undefined });
    const res = await call({ toolName: "" });
    expect(res.status).toBe(400);
    expect(withMcpAdminClientMock).not.toHaveBeenCalled();
  });

  it("forbids non-editor users", async () => {
    getSessionMock.mockResolvedValue({
      user: REGULAR_USER,
      session: { id: "sess-2", userId: REGULAR_USER.id },
    });
    setup({ era: "legacy", taskSupport: undefined });

    const res = await call();
    expect(res.status).toBe(403);
    expect(withMcpAdminClientMock).not.toHaveBeenCalled();
  });
});
