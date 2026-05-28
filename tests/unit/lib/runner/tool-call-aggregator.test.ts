import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  aggregateToolCalls,
  buildToolCallAggregates,
  groupAggregatesByOwnerRun,
  type ToolEventRow,
} from "@/lib/runner/tool-call-aggregator";

/** Build a chunk event row in a single call to keep tests dense. */
function chunkEvent(
  runId: string,
  seq: number,
  toolCallId: string,
  toolName: string,
  ts: string,
): ToolEventRow {
  return {
    runId,
    seq,
    type: "tool_call_chunk",
    ts,
    payload: { toolCallId, toolName, args: "" },
  };
}

function resultEvent(
  runId: string,
  seq: number,
  toolCallId: string,
  ts: string,
  content: unknown = "ok",
): ToolEventRow {
  return {
    runId,
    seq,
    type: "tool_call_result",
    ts,
    payload: { toolCallId, content },
  };
}

describe("buildToolCallAggregates", () => {
  it("returns empty map for empty input", () => {
    expect(buildToolCallAggregates([]).size).toBe(0);
  });

  it("ignores rows whose payload lacks a string toolCallId", () => {
    const result = buildToolCallAggregates([
      { runId: "r1", seq: 0, type: "tool_call_chunk", ts: "t", payload: null },
      { runId: "r1", seq: 1, type: "tool_call_chunk", ts: "t", payload: {} },
      { runId: "r1", seq: 2, type: "tool_call_chunk", ts: "t", payload: { toolCallId: 42 } },
    ]);
    expect(result.size).toBe(0);
  });

  it("ignores non-tool-call event types", () => {
    const result = buildToolCallAggregates([
      { runId: "r1", seq: 0, type: "message", ts: "t", payload: { toolCallId: "x" } },
    ]);
    expect(result.size).toBe(0);
  });

  it("pairs chunk + result in the SAME run", () => {
    const aggs = buildToolCallAggregates([
      chunkEvent("r1", 1, "call_x", "echo", "2024-01-01T00:00:00.000Z"),
      resultEvent("r1", 2, "call_x", "2024-01-01T00:00:01.000Z", "done"),
    ]);
    const a = aggs.get("call_x");
    expect(a).toBeDefined();
    expect(a!.toolName).toBe("echo");
    expect(a!.chunkRunId).toBe("r1");
    expect(a!.resultRunId).toBe("r1");
    expect(a!.startedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(a!.endedAt).toBe("2024-01-01T00:00:01.000Z");
    expect(a!.resultContent).toBe("done");
  });

  it("pairs chunk + result ACROSS runs (HITL / frontend tool)", () => {
    const aggs = buildToolCallAggregates([
      chunkEvent("r1", 2, "call_y", "ask_user_choice", "2024-01-01T00:00:00.000Z"),
      resultEvent("r2", 0, "call_y", "2024-01-01T00:00:15.000Z", "Go"),
    ]);
    const a = aggs.get("call_y")!;
    expect(a.chunkRunId).toBe("r1");
    expect(a.resultRunId).toBe("r2");
    expect(a.toolName).toBe("ask_user_choice");
    expect(a.startedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(a.endedAt).toBe("2024-01-01T00:00:15.000Z");
    expect(a.resultContent).toBe("Go");
  });

  it("leaves resultRunId null when only the chunk exists (true dangling)", () => {
    const aggs = buildToolCallAggregates([
      chunkEvent("r1", 1, "call_dangling", "broken", "2024-01-01T00:00:00.000Z"),
    ]);
    const a = aggs.get("call_dangling")!;
    expect(a.chunkRunId).toBe("r1");
    expect(a.resultRunId).toBeNull();
    expect(a.endedAt).toBeNull();
  });

  it("leaves chunkRunId null when only the result exists", () => {
    const aggs = buildToolCallAggregates([
      resultEvent("r2", 0, "call_orphan", "2024-01-01T00:00:05.000Z", "x"),
    ]);
    const a = aggs.get("call_orphan")!;
    expect(a.chunkRunId).toBeNull();
    expect(a.resultRunId).toBe("r2");
    expect(a.startedAt).toBeNull();
    expect(a.endedAt).toBe("2024-01-01T00:00:05.000Z");
  });

  it("first-seen wins on repeat chunks for the same toolCallId", () => {
    const aggs = buildToolCallAggregates([
      chunkEvent("r1", 1, "call_x", "first", "2024-01-01T00:00:00.000Z"),
      chunkEvent("r1", 2, "call_x", "second", "2024-01-01T00:00:01.000Z"),
    ]);
    const a = aggs.get("call_x")!;
    expect(a.toolName).toBe("first");
    expect(a.chunkSeq).toBe(1);
    expect(a.startedAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("accepts Date as `ts` and re-stringifies", () => {
    const aggs = buildToolCallAggregates([
      {
        runId: "r1",
        seq: 1,
        type: "tool_call_chunk",
        ts: new Date("2024-01-01T00:00:00.000Z"),
        payload: { toolCallId: "call_x", toolName: "echo" },
      },
    ]);
    expect(aggs.get("call_x")!.startedAt).toBe("2024-01-01T00:00:00.000Z");
  });
});

describe("groupAggregatesByOwnerRun", () => {
  it("groups chunk-bearing aggregates under their chunkRunId, not resultRunId", () => {
    const aggs = buildToolCallAggregates([
      chunkEvent("r1", 1, "call_x", "ask", "t1"),
      resultEvent("r2", 0, "call_x", "t2", "Go"),
    ]);
    const grouped = groupAggregatesByOwnerRun(aggs.values());
    expect(grouped.get("r1")?.length).toBe(1);
    expect(grouped.get("r2")).toBeUndefined();
  });

  it("falls back to resultRunId when no chunk exists", () => {
    const aggs = buildToolCallAggregates([
      resultEvent("r2", 0, "call_orphan", "t1", "x"),
    ]);
    const grouped = groupAggregatesByOwnerRun(aggs.values());
    expect(grouped.get("r2")?.length).toBe(1);
  });

  it("orders chunk-bearing entries within a run by chunkSeq", () => {
    const aggs = buildToolCallAggregates([
      chunkEvent("r1", 4, "call_late", "b", "t1"),
      chunkEvent("r1", 2, "call_early", "a", "t0"),
      resultEvent("r1", 5, "call_late", "t2"),
      resultEvent("r1", 3, "call_early", "t1"),
    ]);
    const grouped = groupAggregatesByOwnerRun(aggs.values());
    const r1 = grouped.get("r1")!;
    expect(r1.map((a) => a.toolCallId)).toEqual(["call_early", "call_late"]);
  });

  it("puts chunk-bearing entries before result-only entries within the same owner run", () => {
    // Same owner run holds one chunk-bearing aggregate and one
    // result-only fallback aggregate. Order: chunk-bearing first.
    const aggs = buildToolCallAggregates([
      resultEvent("r1", 0, "call_orphan", "t-orphan", "x"),
      chunkEvent("r1", 1, "call_real", "real", "t-real"),
      resultEvent("r1", 2, "call_real", "t-real-end"),
    ]);
    const grouped = groupAggregatesByOwnerRun(aggs.values());
    const r1 = grouped.get("r1")!;
    expect(r1.map((a) => a.toolCallId)).toEqual(["call_real", "call_orphan"]);
  });
});

describe("aggregateToolCalls (convenience wrapper)", () => {
  it("returns the same shape as build + group composed", () => {
    const events: ToolEventRow[] = [
      chunkEvent("r1", 1, "call_x", "ask", "t1"),
      resultEvent("r2", 0, "call_x", "t2", "Go"),
    ];
    const grouped = aggregateToolCalls(events);
    expect(grouped.size).toBe(1);
    expect(grouped.get("r1")?.[0]?.resultRunId).toBe("r2");
  });
});
