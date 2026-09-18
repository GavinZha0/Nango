import { describe, it, expect, vi } from "vitest";
import {
  buildRepeatTool,
  evaluateStopCondition,
  getByDotPath,
} from "@/lib/repeater/runtime-tools";

describe("getByDotPath", () => {
  it("extracts shallow and deeply nested properties", () => {
    const obj = {
      status: "pending",
      data: {
        task: {
          id: 123,
          state: "ready",
        },
      },
    };

    expect(getByDotPath(obj, "status")).toBe("pending");
    expect(getByDotPath(obj, "data.task.id")).toBe(123);
    expect(getByDotPath(obj, "data.task.state")).toBe("ready");
    expect(getByDotPath(obj, "data.unknown.prop")).toBeUndefined();
    expect(getByDotPath(null, "status")).toBeUndefined();
    expect(getByDotPath(undefined, "status")).toBeUndefined();
    expect(getByDotPath("string", "status")).toBeUndefined();
  });
});

describe("evaluateStopCondition", () => {
  it("evaluates equals condition", () => {
    expect(
      evaluateStopCondition({ status: "ready" }, { field: "status", equals: "ready" }),
    ).toBe(true);
    expect(
      evaluateStopCondition({ status: "running" }, { field: "status", equals: "ready" }),
    ).toBe(false);
    expect(
      evaluateStopCondition({ progress: 100 }, { field: "progress", equals: 100 }),
    ).toBe(true);
    expect(
      evaluateStopCondition({ isDone: true }, { field: "isDone", equals: true }),
    ).toBe(true);
  });

  it("evaluates not_equals condition", () => {
    expect(
      evaluateStopCondition({ status: "running" }, { field: "status", not_equals: "pending" }),
    ).toBe(true);
    expect(
      evaluateStopCondition({ status: "pending" }, { field: "status", not_equals: "pending" }),
    ).toBe(false);
  });

  it("evaluates one_of condition", () => {
    expect(
      evaluateStopCondition(
        { status: "SUCCESS" },
        { field: "status", one_of: ["SUCCESS", "FAILED", "CANCELLED"] },
      ),
    ).toBe(true);
    expect(
      evaluateStopCondition(
        { status: "RUNNING" },
        { field: "status", one_of: ["SUCCESS", "FAILED", "CANCELLED"] },
      ),
    ).toBe(false);
  });

  it("evaluates contains condition on text and JSON", () => {
    expect(
      evaluateStopCondition("Task has finished successfully", { contains: "finished" }),
    ).toBe(true);
    expect(
      evaluateStopCondition({ message: "Server is healthy and ready" }, { contains: "healthy" }),
    ).toBe(true);
    expect(
      evaluateStopCondition({ message: "error loading" }, { contains: "healthy" }),
    ).toBe(false);
  });

  it("returns false if condition is empty or undefined", () => {
    expect(evaluateStopCondition({ status: "ready" }, undefined)).toBe(false);
    expect(evaluateStopCondition({ status: "ready" }, {})).toBe(false);
  });
});

type ToolExecutor = (args: Record<string, unknown>) => Promise<unknown>;

describe("buildRepeatTool", () => {
  it("rejects recursive invocation of repeat_tool", async () => {
    const repeatTool = buildRepeatTool({
      getTool: vi.fn(),
    });

    const result = await (repeatTool.execute as unknown as ToolExecutor)({
      tool_name: "repeat_tool",
    });

    expect(result).toEqual({
      ok: false,
      status: "error",
      error: "RECURSION_FORBIDDEN",
      message: "Cannot invoke 'repeat_tool' recursively.",
    });
  });

  it("returns error if target tool is not found", async () => {
    const repeatTool = buildRepeatTool({
      getTool: () => undefined,
      availableToolNames: () => ["get_weather", "run_query"],
    });

    const result = await (repeatTool.execute as unknown as ToolExecutor)({
      tool_name: "get_state",
    });

    expect(result).toEqual({
      ok: false,
      status: "error",
      error: "TOOL_NOT_FOUND",
      message:
        "Target tool 'get_state' not found or not callable by this agent. Available tools: get_weather, run_query",
    });
  });

  it("returns immediately on 1st probe if stop condition is satisfied", async () => {
    const executeMock = vi.fn().mockResolvedValue({ status: "ready", data: 42 });
    const repeatTool = buildRepeatTool({
      getTool: (name) => (name === "get_state" ? { execute: executeMock } : undefined),
    });

    const result = await (repeatTool.execute as unknown as ToolExecutor)({
      tool_name: "get_state",
      tool_args: { jobId: "job-1" },
      interval_sec: 5,
      timeout_sec: 30,
      stop_condition: { field: "status", equals: "ready" },
    });

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledWith({ jobId: "job-1" });
    expect(result).toEqual({
      ok: true,
      status: "completed",
      result: { status: "ready", data: 42 },
    });
  });

  it("repeats multiple times until condition is met", async () => {
    let callCount = 0;
    const executeMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        return { status: "pending", progress: callCount * 30 };
      }
      return { status: "completed", progress: 100 };
    });

    const sleepMock = vi.fn().mockResolvedValue(undefined);

    const repeatTool = buildRepeatTool({
      getTool: (name) => (name === "get_state" ? { execute: executeMock } : undefined),
      sleepFn: sleepMock,
    });

    const result = await (repeatTool.execute as unknown as ToolExecutor)({
      tool_name: "get_state",
      interval_sec: 5,
      timeout_sec: 30,
      stop_condition: { field: "status", equals: "completed" },
    });

    expect(executeMock).toHaveBeenCalledTimes(3);
    expect(sleepMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledWith(5000);
    expect(result).toEqual({
      ok: true,
      status: "completed",
      result: { status: "completed", progress: 100 },
    });
  });

  it("terminates when max_count is reached without stop_condition", async () => {
    let callCount = 0;
    const executeMock = vi.fn().mockImplementation(async () => {
      callCount++;
      return { attempt: callCount, ok: true };
    });

    const sleepMock = vi.fn().mockResolvedValue(undefined);

    const repeatTool = buildRepeatTool({
      getTool: () => ({ execute: executeMock }),
      sleepFn: sleepMock,
    });

    const result = await (repeatTool.execute as unknown as ToolExecutor)({
      tool_name: "verify_login",
      interval_sec: 5,
      timeout_sec: 60,
      max_count: 3,
    });

    expect(executeMock).toHaveBeenCalledTimes(3);
    expect(sleepMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      ok: true,
      status: "completed",
      result: { attempt: 3, ok: true },
    });
  });

  it("times out if condition is never satisfied within timeout_sec", async () => {
    const executeMock = vi.fn().mockResolvedValue({ status: "running" });

    // Mock Date.now to simulate time advancement
    let currentTime = 1000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => currentTime);

    const sleepMock = vi.fn().mockImplementation(async (ms: number) => {
      currentTime += ms;
    });

    const repeatTool = buildRepeatTool({
      getTool: (_name) => ({ execute: executeMock }),
      sleepFn: sleepMock,
    });

    const result = await (repeatTool.execute as unknown as ToolExecutor)({
      tool_name: "get_state",
      interval_sec: 5,
      timeout_sec: 15,
      stop_condition: { field: "status", equals: "done" },
    });

    expect(result).toEqual({
      ok: true,
      status: "timeout",
      result: { status: "running" },
    });

    expect(executeMock).toHaveBeenCalledTimes(3);

    dateSpy.mockRestore();
  });

  it("unwraps downstream MCP tool CallToolResult envelopes", async () => {
    const mcpEnvelope = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ state: "ready", payload: { count: 99 } }),
        },
      ],
      isError: false,
    };

    const repeatTool = buildRepeatTool({
      getTool: () => ({ execute: vi.fn().mockResolvedValue(mcpEnvelope) }),
    });

    const result = await (repeatTool.execute as unknown as ToolExecutor)({
      tool_name: "mcp_query",
      stop_condition: { field: "state", equals: "ready" },
    });

    expect(result).toEqual({
      ok: true,
      status: "completed",
      result: { state: "ready", payload: { count: 99 } },
    });
  });

  it("catches errors thrown by target tool and returns structured error envelope", async () => {
    const repeatTool = buildRepeatTool({
      getTool: () => ({
        execute: vi.fn().mockRejectedValue(new Error("Connection reset by peer")),
      }),
    });

    const result = await (repeatTool.execute as unknown as ToolExecutor)({
      tool_name: "failing_tool",
    });

    expect(result).toEqual({
      ok: false,
      status: "error",
      error: "TOOL_EXECUTION_FAILED",
      message: "Tool 'failing_tool' threw an error during execution: Connection reset by peer",
    });
  });

  it("handles downstream tools returning isError: true", async () => {
    const repeatTool = buildRepeatTool({
      getTool: () => ({
        execute: vi.fn().mockResolvedValue({
          isError: true,
          message: "Database down",
        }),
      }),
    });

    const result = await (repeatTool.execute as unknown as ToolExecutor)({
      tool_name: "error_tool",
    });

    expect(result).toEqual({
      ok: false,
      status: "error",
      error: "TOOL_EXECUTION_FAILED",
      message: "Tool 'error_tool' reported an error: Database down",
      result: {
        isError: true,
        message: "Database down",
      },
    });
  });
});
