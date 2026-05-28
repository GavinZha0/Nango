import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({
  EntityRunTable: {},
  EntityRunEventTable: {},
}));

const recordRunStart = vi.fn();
const recordEvent = vi.fn();
const finalizeRun = vi.fn();

vi.mock("@/lib/runner/event-store", () => ({
  recordRunStart: (...args: unknown[]) => recordRunStart(...args),
  recordEvent: (...args: unknown[]) => recordEvent(...args),
  finalizeRun: (...args: unknown[]) => finalizeRun(...args),
}));

import {
  mapEngineEventToEventType,
  startRecording,
} from "@/lib/artifacts/workflow-run-recorder";
import type { WorkflowEngineEvent } from "@/lib/workflows/engine";

beforeEach(() => {
  recordRunStart.mockReset();
  recordEvent.mockReset();
  finalizeRun.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mapEngineEventToEventType", () => {
  it("maps run-level events to the existing run vocabulary", () => {
    expect(mapEngineEventToEventType("workflow_started")).toBe("started");
    expect(mapEngineEventToEventType("workflow_completed")).toBe("finished");
    expect(mapEngineEventToEventType("workflow_failed")).toBe("error");
  });

  it("maps node-level events to dedicated workflow_* types", () => {
    expect(mapEngineEventToEventType("workflow_node_attempt_started")).toBe(
      "workflow_node_attempt_started",
    );
    expect(mapEngineEventToEventType("workflow_node_attempt_failed")).toBe(
      "workflow_node_attempt_failed",
    );
    expect(mapEngineEventToEventType("workflow_node_completed")).toBe(
      "workflow_node_completed",
    );
  });
});

describe("startRecording — happy path", () => {
  it("inserts entity_run with `initiator: user` + `entityKind: workflow`", async () => {
    recordRunStart.mockResolvedValue({ id: "run-1" });

    const recorder = await startRecording({
      workflowId: "wf-123",
      ownerId: "user-1",
    });

    expect(recorder).not.toBeNull();
    expect(recorder!.runId).toBe("run-1");
    expect(recordRunStart).toHaveBeenCalledExactlyOnceWith({
      initiator: "user",
      entityId: "wf-123",
      entityKind: "workflow",
      entitySource: "builtin",
      mode: "sync",
      task: "Workflow refresh",
      ownerId: "user-1",
      createdBy: "user-1",
    });
  });

  it("uses workflowName in the input_task label when supplied", async () => {
    recordRunStart.mockResolvedValue({ id: "run-2" });

    await startRecording({
      workflowId: "wf-2",
      workflowName: "Q4 revenue",
      ownerId: "user-1",
    });

    expect(recordRunStart).toHaveBeenCalledWith(
      expect.objectContaining({ task: "Refresh workflow: Q4 revenue" }),
    );
  });

  it("emit() forwards engine events with a monotonic seq", async () => {
    recordRunStart.mockResolvedValue({ id: "run-3" });
    recordEvent.mockResolvedValue(undefined);

    const recorder = await startRecording({
      workflowId: "wf-3",
      ownerId: "user-1",
    });

    const events: WorkflowEngineEvent[] = [
      { type: "workflow_started", runId: "run-3" },
      {
        type: "workflow_node_attempt_started",
        runId: "run-3",
        nodeId: 0,
        attempt: 1,
      },
      {
        type: "workflow_node_completed",
        runId: "run-3",
        nodeId: 0,
        attempt: 1,
        durationMs: 12,
        outputs: { name: "x" },
      },
      { type: "workflow_completed", runId: "run-3", output: { x: 1 } },
    ];
    for (const e of events) recorder!.emit(e);

    // emit is fire-and-forget — give pending promises a tick to settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(recordEvent).toHaveBeenCalledTimes(4);
    expect(recordEvent.mock.calls[0]).toEqual([
      "run-3",
      0,
      "started",
      events[0],
    ]);
    expect(recordEvent.mock.calls[1]).toEqual([
      "run-3",
      1,
      "workflow_node_attempt_started",
      events[1],
    ]);
    expect(recordEvent.mock.calls[2]).toEqual([
      "run-3",
      2,
      "workflow_node_completed",
      events[2],
    ]);
    expect(recordEvent.mock.calls[3]).toEqual([
      "run-3",
      3,
      "finished",
      events[3],
    ]);
  });

  it("succeed() finalizes the run as 'succeeded'", async () => {
    recordRunStart.mockResolvedValue({ id: "run-4" });
    finalizeRun.mockResolvedValue(undefined);

    const recorder = await startRecording({
      workflowId: "wf-4",
      ownerId: "user-1",
    });
    await recorder!.succeed();

    expect(finalizeRun).toHaveBeenCalledExactlyOnceWith("run-4", "succeeded");
  });

  it("fail() finalizes as 'failed' with the Error.message", async () => {
    recordRunStart.mockResolvedValue({ id: "run-5" });
    finalizeRun.mockResolvedValue(undefined);

    const recorder = await startRecording({
      workflowId: "wf-5",
      ownerId: "user-1",
    });
    await recorder!.fail(new Error("connection refused"));

    expect(finalizeRun).toHaveBeenCalledExactlyOnceWith("run-5", "failed", {
      errorMessage: "connection refused",
    });
  });

  it("fail() stringifies non-Error throwables", async () => {
    recordRunStart.mockResolvedValue({ id: "run-6" });
    finalizeRun.mockResolvedValue(undefined);

    const recorder = await startRecording({
      workflowId: "wf-6",
      ownerId: "user-1",
    });
    // Engine could theoretically throw a string or a POJO.
    await recorder!.fail("syntax error in user query");

    expect(finalizeRun).toHaveBeenCalledExactlyOnceWith("run-6", "failed", {
      errorMessage: "syntax error in user query",
    });
  });
});

describe("startRecording — failure modes are best-effort", () => {
  it("returns null when recordRunStart itself throws", async () => {
    recordRunStart.mockRejectedValue(new Error("db down"));

    const recorder = await startRecording({
      workflowId: "wf-x",
      ownerId: "user-1",
    });

    expect(recorder).toBeNull();
    // No emit / finalize attempts because there's no runId to write to.
    expect(recordEvent).not.toHaveBeenCalled();
    expect(finalizeRun).not.toHaveBeenCalled();
  });

  it("emit() swallows recordEvent rejections", async () => {
    recordRunStart.mockResolvedValue({ id: "run-7" });
    recordEvent.mockRejectedValue(new Error("transient"));

    const recorder = await startRecording({
      workflowId: "wf-7",
      ownerId: "user-1",
    });

    // Synchronous from caller's POV — must not throw.
    expect(() =>
      recorder!.emit({ type: "workflow_started", runId: "run-7" }),
    ).not.toThrow();

    // Let the unhandled rejection handler we installed in the recorder
    // catch and log.
    await Promise.resolve();
    await Promise.resolve();
  });

  it("succeed() / fail() swallow finalizeRun rejections", async () => {
    recordRunStart.mockResolvedValue({ id: "run-8" });
    finalizeRun.mockRejectedValue(new Error("connection lost"));

    const recorder = await startRecording({
      workflowId: "wf-8",
      ownerId: "user-1",
    });

    await expect(recorder!.succeed()).resolves.toBeUndefined();
    await expect(recorder!.fail(new Error("boom"))).resolves.toBeUndefined();
  });
});
