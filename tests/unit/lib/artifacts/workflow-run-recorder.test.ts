import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  summarizeOutputsForEvent,
  MAX_EVENT_PREVIEW_ROWS,
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

describe("summarizeOutputsForEvent & bounded audit persistence", () => {
  it("caps large rows array to MAX_EVENT_PREVIEW_ROWS and sets rows_truncated", () => {
    const rawRows = Array.from({ length: 150 }, (_, i) => ({ id: i, val: `v-${i}` }));
    const outputs = {
      dataset_name: "ds_large",
      total_rows: 150,
      rows: rawRows,
    };

    const summarized = summarizeOutputsForEvent(outputs);

    expect(summarized.dataset_name).toBe("ds_large");
    expect(summarized.total_rows).toBe(150);
    expect(Array.isArray(summarized.rows)).toBe(true);
    expect((summarized.rows as unknown[]).length).toBe(MAX_EVENT_PREVIEW_ROWS);
    expect(summarized.rows_truncated).toBe(true);
    // Original array is not mutated
    expect(rawRows.length).toBe(150);
  });

  it("leaves small rows array (<= 20) untouched", () => {
    const rawRows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const outputs = {
      dataset_name: "ds_small",
      rows: rawRows,
    };

    const summarized = summarizeOutputsForEvent(outputs);

    expect(summarized.rows).toEqual(rawRows);
    expect(summarized.rows_truncated).toBeUndefined();
  });

  it("summarizes large ECharts option.dataset.source", () => {
    const rawSource = Array.from({ length: 50 }, (_, i) => ({ x: i, y: i * 2 }));
    const outputs = {
      option: {
        series: [{ type: "bar" }],
        dataset: {
          source: rawSource,
        },
      },
    };

    const summarized = summarizeOutputsForEvent(outputs);
    const option = summarized.option as Record<string, unknown>;
    const dataset = option.dataset as Record<string, unknown>;

    expect(Array.isArray(dataset.source)).toBe(true);
    expect((dataset.source as unknown[]).length).toBe(MAX_EVENT_PREVIEW_ROWS);
    expect(dataset.source_truncated).toBe(true);
    expect(dataset.total_source_items).toBe(50);
  });

  it("truncates excessively large string properties (> 10,000 chars)", () => {
    const hugeString = "a".repeat(25_000);
    const outputs = {
      huge_text: hugeString,
    };

    const summarized = summarizeOutputsForEvent(outputs);

    expect(typeof summarized.huge_text).toBe("string");
    expect((summarized.huge_text as string).length).toBeLessThan(2000);
    expect(summarized.huge_text_truncated).toBe(true);
  });

  it("emit() persists summarized outputs to recordEvent without mutating original event", async () => {
    recordRunStart.mockResolvedValue({ id: "run-bounded" });
    recordEvent.mockResolvedValue(undefined);

    const recorder = await startRecording({
      workflowId: "wf-bounded",
      ownerId: "user-1",
    });

    const originalRows = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const event: WorkflowEngineEvent = {
      type: "workflow_node_completed",
      runId: "run-bounded",
      nodeId: 1,
      attempt: 1,
      durationMs: 45,
      outputs: {
        dataset_name: "ds_test",
        total_rows: 100,
        rows: originalRows,
      },
    };

    recorder!.emit(event);

    await Promise.resolve();
    await Promise.resolve();

    expect(recordEvent).toHaveBeenCalledTimes(1);
    const [, , , persistedPayload] = recordEvent.mock.calls[0] as [
      string,
      number,
      string,
      Record<string, unknown>,
    ];

    expect(persistedPayload.type).toBe("workflow_node_completed");
    const persistedOutputs = persistedPayload.outputs as Record<string, unknown>;
    expect((persistedOutputs.rows as unknown[]).length).toBe(MAX_EVENT_PREVIEW_ROWS);
    expect(persistedOutputs.rows_truncated).toBe(true);

    // Verify original event object was NOT mutated
    expect((event.outputs.rows as unknown[]).length).toBe(100);
  });

  it("P5: preserves both head and tail snippets when truncating oversized strings", () => {
    const headText = "Error: Process terminated abnormally\nStack trace line 1\n";
    const tailText = "\nCaused by: ConnectionRefusedError: port 5432 unreachable at db.ts:99";
    const middlePadding = "x".repeat(30_000);
    const hugeLog = headText + middlePadding + tailText;

    const summarized = summarizeOutputsForEvent({ error_log: hugeLog });
    const result = summarized.error_log as string;

    expect(typeof result).toBe("string");
    expect(result.length).toBeLessThan(2000);
    expect(result.startsWith(headText)).toBe(true);
    expect(result.endsWith(tailText)).toBe(true);
    expect(result).toContain("[truncated");
    expect(summarized.error_log_truncated).toBe(true);
    expect(summarized.error_log_truncated_position).toBe("middle");
  });

  it("P6: recursively caps large arrays nested inside objects", () => {
    const nestedBigArray = Array.from({ length: 80 }, (_, i) => ({ item: i }));
    const outputs = {
      result: {
        payload: {
          items: nestedBigArray,
        },
      },
    };

    const summarized = summarizeOutputsForEvent(outputs);
    const result = summarized.result as Record<string, unknown>;
    const payload = result.payload as Record<string, unknown>;

    expect(Array.isArray(payload.items)).toBe(true);
    expect((payload.items as unknown[]).length).toBe(MAX_EVENT_PREVIEW_ROWS);
    expect(payload.items_truncated).toBe(true);
    expect(payload.items_total_count).toBe(80);
  });

  it("P6: restricts deep recursion beyond MAX_EVENT_NESTING_DEPTH", () => {
    const deepObject = {
      l1: {
        l2: {
          l3: {
            l4: {
              data: "too deep",
            },
          },
        },
      },
    };

    const summarized = summarizeOutputsForEvent(deepObject);
    const l1 = summarized.l1 as Record<string, unknown>;
    const l2 = l1.l2 as Record<string, unknown>;
    const l3 = l2.l3 as Record<string, unknown>;

    // At depth 3, l3 is truncated
    expect(l3).toEqual({ _truncated_depth: true });
  });
});


