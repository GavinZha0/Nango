import { describe, expect, it } from "vitest";

import {
  coalesceToolCalls,
  type RawRunEvent,
} from "@/lib/artifacts/coalesce-tool-calls";

// ─── Fixtures ─────────────────────────────────────────────────────────

function chunk(
  seq: number,
  toolCallId: string,
  toolName: string,
  args: string,
): RawRunEvent {
  return {
    seq,
    type: "tool_call_chunk",
    payload: { toolCallId, toolName, args },
  };
}

function result(seq: number, toolCallId: string, content: string): RawRunEvent {
  return {
    seq,
    type: "tool_call_result",
    payload: { toolCallId, content },
  };
}

// ─── Happy paths ──────────────────────────────────────────────────────

describe("coalesceToolCalls — happy paths", () => {
  it("coalesces a single tool call (one chunk + result)", () => {
    const events: RawRunEvent[] = [
      chunk(1, "call-a", "fetch_data_table", '{"sql":"select 1"}'),
      result(2, "call-a", '{"dataset":"ds_orders_q4"}'),
    ];
    const inv = coalesceToolCalls(events);
    expect(inv).toHaveLength(1);
    expect(inv[0]).toEqual({
      callId: "call-a",
      seq: 1,
      toolName: "fetch_data_table",
      input: { sql: "select 1" },
      result: { dataset: "ds_orders_q4" },
      ok: true,
    });
  });

  it("concatenates multiple chunks of streamed args before parsing", () => {
    // Streaming case: Vercel AI SDK sends incremental args.
    const events: RawRunEvent[] = [
      chunk(1, "call-a", "fetch_data_table", '{"sql":'),
      chunk(2, "call-a", "", '"select * from o"'),
      chunk(3, "call-a", "", ', "limit": 100}'),
      result(4, "call-a", '{"dataset":"ds_orders_q4"}'),
    ];
    const inv = coalesceToolCalls(events);
    expect(inv).toHaveLength(1);
    expect(inv[0]!.input).toEqual({
      sql: "select * from o",
      limit: 100,
    });
  });

  it("preserves chronological order via first-chunk seq", () => {
    const events: RawRunEvent[] = [
      chunk(1, "call-a", "extract", "{}"),
      chunk(2, "call-b", "transform", "{}"),
      result(3, "call-a", "{}"),
      chunk(4, "call-c", "render", "{}"),
      result(5, "call-b", "{}"),
      result(6, "call-c", "{}"),
    ];
    const inv = coalesceToolCalls(events);
    expect(inv.map((i) => i.callId)).toEqual(["call-a", "call-b", "call-c"]);
    expect(inv.map((i) => i.seq)).toEqual([1, 2, 4]);
  });

  it("processes events even when out-of-order in the input array", () => {
    // Caller passed events not pre-sorted — coalesce re-sorts.
    const events: RawRunEvent[] = [
      result(2, "call-a", '{"x":1}'),
      chunk(1, "call-a", "tool_x", "{}"),
    ];
    const inv = coalesceToolCalls(events);
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ ok: true, result: { x: 1 } });
  });
});

// ─── Failure modes ────────────────────────────────────────────────────

describe("coalesceToolCalls — failure modes", () => {
  it("marks a call as ok=false / result=null when no result event arrived", () => {
    // Tool started streaming args but never completed (e.g. abort).
    const events: RawRunEvent[] = [
      chunk(1, "call-a", "tool_x", '{"foo":"bar"}'),
    ];
    const inv = coalesceToolCalls(events);
    expect(inv).toHaveLength(1);
    expect(inv[0]!.ok).toBe(false);
    expect(inv[0]!.result).toBeNull();
    // The input is still recovered (so debug paths see partial state).
    expect(inv[0]!.input).toEqual({ foo: "bar" });
  });

  it("ignores a result event with no matching chunk (unknown toolCallId)", () => {
    const events: RawRunEvent[] = [
      result(1, "orphan-call", '{"foo":1}'),
    ];
    expect(coalesceToolCalls(events)).toEqual([]);
  });

  it("wraps non-object result content as { value: <parsed> }", () => {
    // Some tools return primitives / arrays — wrap so downstream
    // consumers always get Record<string, unknown>.
    const events: RawRunEvent[] = [
      chunk(1, "call-a", "tool_x", "{}"),
      result(2, "call-a", '"raw string return"'),
    ];
    const inv = coalesceToolCalls(events);
    expect(inv[0]!.ok).toBe(true);
    expect(inv[0]!.result).toEqual({ value: "raw string return" });
  });

  it("wraps array result content", () => {
    const events: RawRunEvent[] = [
      chunk(1, "call-a", "tool_x", "{}"),
      result(2, "call-a", "[1,2,3]"),
    ];
    const inv = coalesceToolCalls(events);
    expect(inv[0]!.result).toEqual({ value: [1, 2, 3] });
  });

  it("marks ok=false when result content is not valid JSON", () => {
    const events: RawRunEvent[] = [
      chunk(1, "call-a", "tool_x", "{}"),
      result(2, "call-a", "<<not json>>"),
    ];
    const inv = coalesceToolCalls(events);
    expect(inv[0]!.ok).toBe(false);
    expect(inv[0]!.result).toBeNull();
  });

  it("treats empty / blank result content as a failed call", () => {
    const events: RawRunEvent[] = [
      chunk(1, "call-a", "tool_x", "{}"),
      result(2, "call-a", ""),
    ];
    const inv = coalesceToolCalls(events);
    expect(inv[0]!.ok).toBe(false);
  });

  it("marks ok=false for the Nango tool envelope failure shape", () => {
    // Nango tools (fetch_data_table, web_search, …) return
    // `{ ok: false, error: { code, message } }` on semantic
    // failure. JSON parses fine, but the call did not produce
    // usable output — downstream nodes can't reference it, so the
    // save pipeline must skip it.
    const events: RawRunEvent[] = [
      chunk(1, "call-a", "fetch_data_table", '{"name":"ds_x"}'),
      result(
        2,
        "call-a",
        '{"ok":false,"error":{"code":"QUERY_HASH_MISMATCH","message":"…"}}',
      ),
    ];
    const inv = coalesceToolCalls(events);
    expect(inv).toHaveLength(1);
    expect(inv[0]!.ok).toBe(false);
    expect(inv[0]!.result).toBeNull();
    // Input is still recovered — useful for save-time forensics.
    expect(inv[0]!.input).toEqual({ name: "ds_x" });
  });

  it("treats ok:true envelopes as success (current contract)", () => {
    const events: RawRunEvent[] = [
      chunk(1, "call-a", "fetch_data_table", "{}"),
      result(2, "call-a", '{"ok":true,"cacheHit":false,"name":"ds_y"}'),
    ];
    const inv = coalesceToolCalls(events);
    expect(inv[0]!.ok).toBe(true);
    expect(inv[0]!.result).toEqual({
      ok: true,
      cacheHit: false,
      name: "ds_y",
    });
  });

  it("non-envelope results pass through as success when JSON parses", () => {
    // Tools that don't follow the envelope (legacy / external)
    // shouldn't be penalised by the envelope check — only an
    // explicit `ok: false` triggers the failure branch.
    const events: RawRunEvent[] = [
      chunk(1, "call-a", "legacy_tool", "{}"),
      result(2, "call-a", '{"dataset":"foo"}'),
    ];
    const inv = coalesceToolCalls(events);
    expect(inv[0]!.ok).toBe(true);
    expect(inv[0]!.result).toEqual({ dataset: "foo" });
  });

  it("marks ok=false for the process-result envelope when exitCode != 0", () => {
    // `run_code_in_sandbox` shape: { stdout, stderr, exitCode,
    // durationMs, backend }. A non-zero exitCode means the script
    // crashed — Python traceback, OOM, missing module, etc. The
    // call is semantically failed even though the envelope JSON
    // parsed fine.
    const events: RawRunEvent[] = [
      chunk(1, "call-sb", "run_code_in_sandbox", '{"command":["python3","-"]}'),
      result(
        2,
        "call-sb",
        '{"stdout":"","stderr":"ModuleNotFoundError: No module named \'duckdb\'","exitCode":1,"durationMs":62,"backend":"subprocess"}',
      ),
    ];
    const inv = coalesceToolCalls(events);
    expect(inv).toHaveLength(1);
    expect(inv[0]!.ok).toBe(false);
    expect(inv[0]!.result).toBeNull();
    expect(inv[0]!.input).toEqual({ command: ["python3", "-"] });
  });

  it("treats exitCode=0 as success (process-result envelope)", () => {
    const events: RawRunEvent[] = [
      chunk(1, "call-sb", "run_code_in_sandbox", '{"command":["python3","-"]}'),
      result(
        2,
        "call-sb",
        '{"stdout":"hello","stderr":"","exitCode":0,"durationMs":10,"backend":"subprocess"}',
      ),
    ];
    const inv = coalesceToolCalls(events);
    expect(inv[0]!.ok).toBe(true);
    expect(inv[0]!.result).toMatchObject({ exitCode: 0, stdout: "hello" });
  });

  it("non-numeric / absent exitCode is not treated as failure", () => {
    // Defensive: only a `typeof === 'number'` exitCode triggers
    // the check. A tool that returns { exitCode: "0" } (string) or
    // omits the field is treated as ok.
    const events: RawRunEvent[] = [
      chunk(1, "call-a", "weird_tool", "{}"),
      result(2, "call-a", '{"exitCode":"oops","payload":42}'),
    ];
    const inv = coalesceToolCalls(events);
    expect(inv[0]!.ok).toBe(true);
  });

  it("falls back to {} for unparseable / empty args", () => {
    const events: RawRunEvent[] = [
      chunk(1, "call-a", "tool_x", ""),
      result(2, "call-a", '{"ok":true}'),
    ];
    const inv = coalesceToolCalls(events);
    expect(inv[0]!.input).toEqual({});
    expect(inv[0]!.ok).toBe(true); // result still parses
  });

  it("ignores unknown event types", () => {
    const events: RawRunEvent[] = [
      { seq: 1, type: "started", payload: {} },
      chunk(2, "call-a", "tool_x", "{}"),
      { seq: 3, type: "reasoning", payload: { text: "thinking..." } },
      result(4, "call-a", "{}"),
      { seq: 5, type: "finished", payload: {} },
    ];
    const inv = coalesceToolCalls(events);
    expect(inv).toHaveLength(1);
    expect(inv[0]!.callId).toBe("call-a");
  });

  it("ignores chunk events with malformed payloads", () => {
    const events: RawRunEvent[] = [
      // Missing toolCallId
      { seq: 1, type: "tool_call_chunk", payload: { toolName: "x", args: "{}" } },
      // Payload not an object
      { seq: 2, type: "tool_call_chunk", payload: "garbage" },
      // Payload null
      { seq: 3, type: "tool_call_chunk", payload: null },
      // Valid one
      chunk(4, "call-real", "ok_tool", "{}"),
      result(5, "call-real", "{}"),
    ];
    const inv = coalesceToolCalls(events);
    expect(inv).toHaveLength(1);
    expect(inv[0]!.callId).toBe("call-real");
  });

  it("first non-empty toolName wins across chunks", () => {
    // First chunk often carries the name; subsequent chunks may omit it.
    const events: RawRunEvent[] = [
      chunk(1, "call-a", "", "{}"), // empty toolName
      chunk(2, "call-a", "real_name", ""),
      result(3, "call-a", "{}"),
    ];
    const inv = coalesceToolCalls(events);
    expect(inv[0]!.toolName).toBe("real_name");
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────

describe("coalesceToolCalls — edge cases", () => {
  it("returns empty array for empty input", () => {
    expect(coalesceToolCalls([])).toEqual([]);
  });

  it("handles interleaved calls correctly (parallel tool execution)", () => {
    // call-a and call-b run in parallel; their chunks interleave.
    const events: RawRunEvent[] = [
      chunk(1, "call-a", "tool_x", '{"x":'),
      chunk(2, "call-b", "tool_y", '{"y":'),
      chunk(3, "call-a", "", '"a-args"}'),
      chunk(4, "call-b", "", '"b-args"}'),
      result(5, "call-a", '{"ok":"a"}'),
      result(6, "call-b", '{"ok":"b"}'),
    ];
    const inv = coalesceToolCalls(events);
    expect(inv).toHaveLength(2);
    const callA = inv.find((i) => i.callId === "call-a");
    const callB = inv.find((i) => i.callId === "call-b");
    expect(callA?.input).toEqual({ x: "a-args" });
    expect(callA?.result).toEqual({ ok: "a" });
    expect(callB?.input).toEqual({ y: "b-args" });
    expect(callB?.result).toEqual({ ok: "b" });
  });
});
