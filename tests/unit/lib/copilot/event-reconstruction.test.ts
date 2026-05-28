import { beforeEach, describe, expect, it, vi } from "vitest";
import { firstValueFrom, toArray } from "rxjs";

vi.mock("server-only", () => ({}));

// Mock drizzle's chain — two `select-from-where-orderBy` calls per
// `reconstructFromDb` invocation: one for runs, one for events. We
// stage the return values per call.
const orderBy = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy,
        })),
      })),
    })),
  },
}));

// Drizzle column references are opaque tokens for our purposes. The
// chain mock above ignores the actual `where`/`orderBy` arguments.
vi.mock("@/lib/db/schema", () => ({
  EntityRunTable: {
    id: "id",
    parentRunId: "parent_run_id",
    threadId: "thread_id",
    ownerId: "owner_id",
    startedAt: "started_at",
    createdAt: "created_at",
    status: "status",
  },
  EntityRunEventTable: {
    runId: "run_id",
    seq: "seq",
    type: "type",
    payload: "payload",
  },
}));

const noopLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Parameters<
  Awaited<typeof import("@/lib/copilot/event-reconstruction")>["reconstructFromDb"]
>[0]["log"];

const { reconstructFromDb, synthesizeToolCallResult } = await import(
  "@/lib/copilot/event-reconstruction"
);
const { EventType, EventSchemas } = await import("@/lib/copilot/index.server");

// helpers

function stageQueries(runs: unknown[], events: unknown[]): void {
  orderBy.mockResolvedValueOnce(runs).mockResolvedValueOnce(events);
}

async function collect(threadId: string, ownerId: string) {
  const obs = reconstructFromDb({ threadId, ownerId, log: noopLog });
  return firstValueFrom(obs.pipe(toArray()));
}

function makeRun(overrides: Partial<{
  id: string;
  status: string;
  inputTask: string;
}> = {}) {
  return {
    id: "run-1",
    parentRunId: null,
    threadId: "thread-1",
    initiator: "user",
    entityId: "agent-1",
    entityKind: "agent",
    entitySource: "builtin",
    credentialId: null,
    mode: "sync",
    status: "succeeded",
    inputTask: "hello",
    inputContext: null,
    inputParams: null,
    outputSummary: null,
    outputArtifacts: null,
    errorMessage: null,
    errorDetails: null,
    ownerId: "user-1",
    startedAt: new Date("2024-01-01T00:00:00Z"),
    finishedAt: new Date("2024-01-01T00:00:05Z"),
    deadline: null,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    createdBy: "user-1",
    ...overrides,
  };
}

function makeEvent(
  runId: string,
  seq: number,
  type: string,
  payload: Record<string, unknown> | null,
) {
  return {
    runId,
    seq,
    type,
    payload,
    ts: new Date(`2024-01-01T00:00:0${seq}Z`),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  orderBy.mockReset();
});

// region: top-level shape

describe("reconstructFromDb — empty thread", () => {
  it("emits no events when no runs exist", async () => {
    orderBy.mockResolvedValueOnce([]); // runs query returns empty
    const events = await collect("thread-1", "user-1");
    expect(events).toEqual([]);
  });
});

describe("reconstructFromDb — single text-only run", () => {
  it("wraps a single message row in RUN_STARTED/FINISHED", async () => {
    const run = makeRun();
    const evs = [
      makeEvent(run.id, 0, "started", { type: "RUN_STARTED" }), // suppressed
      makeEvent(run.id, 1, "message", {
        messageId: "msg-1",
        role: "assistant",
        text: "hello world",
      }),
      makeEvent(run.id, 2, "finished", { type: "RUN_FINISHED" }), // suppressed
    ];
    stageQueries([run], evs);

    const out = await collect("thread-1", "user-1");

    expect(out.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    const firstStart = out[1] as unknown as { role: string };
    expect(firstStart.role).toBe("assistant");
  });

  it("emits a user-role message row through the standard message arm", async () => {
    // Modern path: runner.recordUserMessage writes the user's prompt
    // as a `message` event row with `role: "user"` and the client's
    // original message id at seq 0. The reconstructor replays it
    // through the same arm as assistant messages.
    const run = makeRun({ inputTask: "draw me a chart" });
    const evs = [
      makeEvent(run.id, 0, "message", {
        messageId: "client-msg-uuid",
        role: "user",
        text: "draw me a chart",
      }),
      makeEvent(run.id, 1, "message", {
        messageId: "asst-msg-1",
        role: "assistant",
        text: "here you go",
      }),
    ];
    stageQueries([run], evs);

    const out = await collect("thread-1", "user-1");
    const userStart = out.find(
      (e) =>
        e.type === EventType.TEXT_MESSAGE_START &&
        (e as unknown as { role: string }).role === "user",
    ) as unknown as { messageId: string } | undefined;
    expect(userStart).toBeDefined();
    // Critical: id must be the client-generated one so CopilotKit's
    // apply pipeline dedupes against the locally-typed state. Using
    // a server-generated fallback would render the prompt twice.
    expect(userStart!.messageId).toBe("client-msg-uuid");
  });
});

// endregion

// region: tool-call handling

describe("reconstructFromDb — backend tool with real result", () => {
  it("does not synthesize when tool_call_result row exists", async () => {
    const run = makeRun();
    const evs = [
      makeEvent(run.id, 0, "tool_call_chunk", {
        toolCallId: "call-a",
        toolName: "extract_dataset_by_sql",
        args: '{"sql":"select 1"}',
      }),
      makeEvent(run.id, 1, "tool_call_result", {
        toolCallId: "call-a",
        content: '{"rows":[]}',
      }),
    ];
    stageQueries([run], evs);

    const out = await collect("thread-1", "user-1");

    // Should see exactly one TOOL_CALL_RESULT (the real one), not
    // additionally a synthesized one.
    const results = out.filter((e) => e.type === EventType.TOOL_CALL_RESULT);
    expect(results).toHaveLength(1);
    const r = results[0]! as unknown as {
      content: string;
      messageId: string;
      toolCallId: string;
    };
    expect(r.toolCallId).toBe("call-a");
    expect(r.content).toBe('{"rows":[]}');
    // Real-result messageId is derived from run.id + seq; synthesised
    // results use the `synth.` prefix. We expect the non-synthetic
    // form here.
    expect(r.messageId.startsWith("synth.")).toBe(false);
  });
});

describe("reconstructFromDb — frontend tool, succeeded run", () => {
  it("synthesises { ok:true, chartId } for render_chart with parseable args", async () => {
    const run = makeRun();
    const evs = [
      makeEvent(run.id, 0, "tool_call_chunk", {
        toolCallId: "call-r",
        toolName: "render_chart",
        args: '{"chartId":"sales-pie","title":"Sales"}',
      }),
      // No matching tool_call_result row
      makeEvent(run.id, 1, "message", {
        messageId: "msg-1",
        role: "assistant",
        text: "Chart rendered.",
      }),
    ];
    stageQueries([run], evs);

    const out = await collect("thread-1", "user-1");

    const results = out.filter((e) => e.type === EventType.TOOL_CALL_RESULT);
    expect(results).toHaveLength(1);
    const r = results[0]! as unknown as { content: string; messageId: string };
    // Synthetic warning envelope: { isError, severity, message, chartId }.
    // Three fields are guaranteed; chartId is the per-render_chart
    // enrichment for the LLM's downstream "update the chart" turn.
    expect(JSON.parse(r.content)).toEqual({
      isError: true,
      severity: "warning",
      message: "No tool result was recorded — outcome inferred.",
      chartId: "sales-pie",
    });
    expect(r.messageId.startsWith("synth.")).toBe(true);

    // Ordering: synthetic result must appear AFTER the chunk's
    // TOOL_CALL_END and BEFORE the follow-up assistant message.
    // Use lastIndexOf for the assistant TEXT_MESSAGE_START since the
    // first one belongs to the synthesised user prompt at the top.
    const types = out.map((e) => e.type);
    const endIdx = types.indexOf(EventType.TOOL_CALL_END);
    const resultIdx = types.indexOf(EventType.TOOL_CALL_RESULT);
    const assistantMsgStartIdx = types.lastIndexOf(EventType.TEXT_MESSAGE_START);
    expect(endIdx).toBeLessThan(resultIdx);
    expect(resultIdx).toBeLessThan(assistantMsgStartIdx);
  });
});

describe("reconstructFromDb — frontend tool, non-succeeded run", () => {
  it("synthesises an error-severity envelope when run.status is 'failed'", async () => {
    const run = makeRun({ status: "failed" });
    const evs = [
      makeEvent(run.id, 0, "tool_call_chunk", {
        toolCallId: "call-x",
        toolName: "render_chart",
        args: '{"chartId":"abc"}',
      }),
    ];
    stageQueries([run], evs);

    const out = await collect("thread-1", "user-1");

    const results = out.filter((e) => e.type === EventType.TOOL_CALL_RESULT);
    expect(results).toHaveLength(1);
    const r = results[0]! as unknown as { content: string };
    // Non-succeeded run -> error severity (UI shows red badge). Note:
    // run_aborted has no per-tool chartId enrichment because the
    // chart was never actually rendered.
    expect(JSON.parse(r.content)).toEqual({
      isError: true,
      severity: "error",
      message: "Run aborted before this tool completed.",
    });
  });
});

describe("reconstructFromDb — generic frontend tool fallback", () => {
  // Generic fallback: same warning envelope, no per-tool enrichment.
  const genericWarning = {
    isError: true,
    severity: "warning",
    message: "No tool result was recorded — outcome inferred.",
  };

  it("synthesises a warning envelope for unknown tools with parseable args", async () => {
    const run = makeRun();
    const evs = [
      makeEvent(run.id, 0, "tool_call_chunk", {
        toolCallId: "call-g",
        toolName: "some_future_tool",
        args: '{"foo":"bar"}',
      }),
    ];
    stageQueries([run], evs);

    const out = await collect("thread-1", "user-1");
    const result = out.find(
      (e) => e.type === EventType.TOOL_CALL_RESULT,
    ) as unknown as { content: string } | undefined;
    expect(result).toBeDefined();
    expect(JSON.parse(result!.content)).toEqual(genericWarning);
  });

  it("synthesises a warning envelope for render_chart with malformed args (chartId not recoverable)", async () => {
    const run = makeRun();
    const evs = [
      makeEvent(run.id, 0, "tool_call_chunk", {
        toolCallId: "call-m",
        toolName: "render_chart",
        args: "not-json",
      }),
    ];
    stageQueries([run], evs);

    const out = await collect("thread-1", "user-1");
    const result = out.find(
      (e) => e.type === EventType.TOOL_CALL_RESULT,
    ) as unknown as { content: string } | undefined;
    expect(result).toBeDefined();
    expect(JSON.parse(result!.content)).toEqual(genericWarning);
  });
});

// endregion

// region: multi-run

describe("reconstructFromDb — multi-run thread", () => {
  it("emits one RUN_STARTED/FINISHED pair per run, in DB order", async () => {
    const run1 = makeRun({ id: "run-1" });
    const run2 = makeRun({ id: "run-2" });
    const evs = [
      makeEvent("run-1", 0, "message", {
        messageId: "m1",
        role: "user",
        text: "hi",
      }),
      makeEvent("run-2", 0, "message", {
        messageId: "m2",
        role: "assistant",
        text: "hello",
      }),
    ];
    stageQueries([run1, run2], evs);

    const out = await collect("thread-1", "user-1");
    const types = out.map((e) => e.type);

    // Expect two RUN_STARTED + two RUN_FINISHED bracketing two
    // TEXT_MESSAGE_* triplets.
    const startedIndices = types
      .map((t, i) => (t === EventType.RUN_STARTED ? i : -1))
      .filter((i) => i !== -1);
    expect(startedIndices).toHaveLength(2);

    const finishedIndices = types
      .map((t, i) => (t === EventType.RUN_FINISHED ? i : -1))
      .filter((i) => i !== -1);
    expect(finishedIndices).toHaveLength(2);

    // Each FINISHED follows its STARTED.
    expect(startedIndices[0]).toBeLessThan(finishedIndices[0]!);
    expect(finishedIndices[0]).toBeLessThan(startedIndices[1]!);
    expect(startedIndices[1]).toBeLessThan(finishedIndices[1]!);
  });

  it("emits one user TEXT_MESSAGE_START per persisted user-message row across runs", async () => {
    // Two HTTP-dispatched runs, each persists its own user-message
    // row at seq 0 (the frontend-tool continuation case persists the
    // SAME client message id on both, so client-side dedup leaves
    // one rendered turn; here we use distinct ids to confirm both
    // surface server-side).
    const run1 = makeRun({ id: "run-1", inputTask: "first question" });
    const run2 = makeRun({ id: "run-2", inputTask: "second question" });
    const evs = [
      makeEvent("run-1", 0, "message", {
        messageId: "user-1",
        role: "user",
        text: "first question",
      }),
      makeEvent("run-1", 1, "message", {
        messageId: "asst-1",
        role: "assistant",
        text: "first answer",
      }),
      makeEvent("run-2", 0, "message", {
        messageId: "user-2",
        role: "user",
        text: "second question",
      }),
      makeEvent("run-2", 1, "message", {
        messageId: "asst-2",
        role: "assistant",
        text: "second answer",
      }),
    ];
    stageQueries([run1, run2], evs);

    const out = await collect("thread-1", "user-1");
    const userStarts = out.filter(
      (e) =>
        e.type === EventType.TEXT_MESSAGE_START &&
        (e as unknown as { role: string }).role === "user",
    );
    expect(userStarts).toHaveLength(2);
    expect(
      userStarts.map((e) => (e as unknown as { messageId: string }).messageId),
    ).toEqual(["user-1", "user-2"]);
  });

  it("dedupes the user-message row across runs that share its messageId (frontend-tool continuation)", async () => {
    // Canonical frontend-tool flow: run-1 carries the chart's
    // tool_call_chunk; run-2 is the LLM continuation seeded by
    // CopilotKit core. `extractRunInput` on run-2 reads the latest
    // user message from the body — still the original prompt —
    // so `recordUserMessage` writes a `message` row with the SAME
    // client-generated messageId at seq 0 of run-2.
    //
    // The reconstructor MUST collapse those into a single emitted
    // user TEXT_MESSAGE_* triplet on `/connect` replay, otherwise a
    // cold client (Tab switch + come back) renders the user prompt
    // twice.
    const run1 = makeRun({ id: "run-1", inputTask: "draw a chart + python" });
    const run2 = makeRun({ id: "run-2", inputTask: "draw a chart + python" });
    const evs = [
      makeEvent("run-1", 0, "message", {
        messageId: "client-user-uuid",
        role: "user",
        text: "draw a chart + python",
      }),
      makeEvent("run-1", 1, "tool_call_chunk", {
        toolCallId: "tc-1",
        toolName: "render_chart",
        args: '{"chartId":"x","title":"X","optionJson":"{}"}',
      }),
      makeEvent("run-2", 0, "message", {
        // SAME id as run-1's user message — persisted by
        // recordUserMessage on the continuation POST.
        messageId: "client-user-uuid",
        role: "user",
        text: "draw a chart + python",
      }),
      makeEvent("run-2", 1, "message", {
        messageId: "asst-2",
        role: "assistant",
        text: "Here's the chart + Python script:",
      }),
    ];
    stageQueries([run1, run2], evs);

    const out = await collect("thread-1", "user-1");
    const userStarts = out.filter(
      (e) =>
        e.type === EventType.TEXT_MESSAGE_START &&
        (e as unknown as { role: string }).role === "user",
    );
    // Critical assertion: the user prompt surfaces ONCE, not twice.
    expect(userStarts).toHaveLength(1);
    expect((userStarts[0] as unknown as { messageId: string }).messageId).toBe(
      "client-user-uuid",
    );
    // And the assistant continuation in run-2 must still survive —
    // dedup is scoped to its own messageId, not a blanket "second run
    // is suppressed" rule.
    const asstStarts = out.filter(
      (e) =>
        e.type === EventType.TEXT_MESSAGE_START &&
        (e as unknown as { role: string }).role === "assistant",
    );
    expect(asstStarts).toHaveLength(1);
  });

  it("does not dedup assistant rows with fallback (server-generated) messageIds", async () => {
    // Defensive: when payload.messageId is missing the per-row
    // emitter falls back to `${runId}.msg.${seq}`, which embeds runId
    // and therefore cannot collide across runs. Both messages must
    // surface.
    const run1 = makeRun({ id: "run-1" });
    const run2 = makeRun({ id: "run-2" });
    const evs = [
      makeEvent("run-1", 0, "message", {
        // messageId intentionally omitted
        role: "assistant",
        text: "first",
      }),
      makeEvent("run-2", 0, "message", {
        role: "assistant",
        text: "second",
      }),
    ];
    stageQueries([run1, run2], evs);

    const out = await collect("thread-1", "user-1");
    const starts = out.filter((e) => e.type === EventType.TEXT_MESSAGE_START);
    expect(starts).toHaveLength(2);
  });
});

// endregion

// region: reasoning + skipped types

describe("reconstructFromDb — reasoning row", () => {
  it("expands to the five REASONING_* events", async () => {
    const run = makeRun();
    const evs = [
      makeEvent(run.id, 0, "reasoning", {
        messageId: "r1",
        text: "Let me think...",
      }),
    ];
    stageQueries([run], evs);

    const out = await collect("thread-1", "user-1");
    const types = out
      .map((e) => e.type)
      .filter((t) =>
        [
          EventType.REASONING_START,
          EventType.REASONING_MESSAGE_START,
          EventType.REASONING_MESSAGE_CONTENT,
          EventType.REASONING_MESSAGE_END,
          EventType.REASONING_END,
        ].includes(t as never),
      );
    expect(types).toEqual([
      EventType.REASONING_START,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.REASONING_END,
    ]);
  });

  it("skips reasoning rows whose text is empty / whitespace only", async () => {
    const run = makeRun();
    const evs = [
      makeEvent(run.id, 0, "reasoning", {
        messageId: "r1",
        text: "   ",
      }),
    ];
    stageQueries([run], evs);

    const out = await collect("thread-1", "user-1");
    const reasoningTypes = out
      .map((e) => e.type)
      .filter((t) => String(t).startsWith("REASONING_"));
    expect(reasoningTypes).toEqual([]);
  });
});

describe("reconstructFromDb — skipped row types", () => {
  it("suppresses started, final and degraded rows", async () => {
    // Empty inputTask so the synthesised user message doesn't appear and we
    // can assert only the wrapper RUN_STARTED/FINISHED survive.
    const run = makeRun({ inputTask: "" });
    const evs = [
      makeEvent(run.id, 0, "started", { type: "RUN_STARTED" }),
      makeEvent(run.id, 1, "degraded", {
        capability: "mcp_server",
        message: "dropped",
      }),
      makeEvent(run.id, 2, "finished", { type: "RUN_FINISHED" }),
    ];
    stageQueries([run], evs);

    const out = await collect("thread-1", "user-1");
    // Only our own wrapping RUN_STARTED + RUN_FINISHED should appear.
    const types = out.map((e) => e.type);
    expect(types).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);
  });
});

describe("reconstructFromDb — error row", () => {
  it("emits a RUN_ERROR with DB_REPLAY code", async () => {
    const run = makeRun({ status: "failed" });
    const evs = [
      makeEvent(run.id, 0, "error", {
        message: "Something blew up",
      }),
    ];
    stageQueries([run], evs);

    const out = await collect("thread-1", "user-1");
    const err = out.find((e) => e.type === EventType.RUN_ERROR) as unknown as
      | { message: string; code?: string }
      | undefined;
    expect(err).toBeDefined();
    expect(err!.message).toBe("Something blew up");
    expect(err!.code).toBe("DB_REPLAY");
  });
});

// endregion

// region: timestamps (AG-UI BaseEvent.timestamp from entity_run_event.ts)

describe("reconstructFromDb — tool-call events carry persisted timestamps", () => {
  it("stamps TOOL_CALL_START / ARGS / END / RESULT with the row's ts", async () => {
    // Two separate DB rows: chunk at seq=1 (ts = 2024-01-01T00:00:01Z),
    // result at seq=2 (ts = 2024-01-01T00:00:02Z). The three events
    // derived from the chunk row must share the chunk's ts; the
    // RESULT event must carry the result row's ts so client-side
    // duration = result.ts - chunk.ts = 1000 ms.
    const run = makeRun();
    const evs = [
      makeEvent(run.id, 1, "tool_call_chunk", {
        toolCallId: "call-ts",
        toolName: "run_ssh_command",
        args: '{"serverName":"x"}',
      }),
      makeEvent(run.id, 2, "tool_call_result", {
        toolCallId: "call-ts",
        content: '{"ok":true}',
      }),
    ];
    stageQueries([run], evs);

    const out = await collect("thread-1", "user-1");

    const chunkTs = new Date("2024-01-01T00:00:01Z").getTime();
    const resultTs = new Date("2024-01-01T00:00:02Z").getTime();

    const start = out.find((e) => e.type === EventType.TOOL_CALL_START) as
      | { timestamp?: number }
      | undefined;
    const args = out.find((e) => e.type === EventType.TOOL_CALL_ARGS) as
      | { timestamp?: number }
      | undefined;
    const end = out.find((e) => e.type === EventType.TOOL_CALL_END) as
      | { timestamp?: number }
      | undefined;
    const result = out.find((e) => e.type === EventType.TOOL_CALL_RESULT) as
      | { timestamp?: number }
      | undefined;

    expect(start?.timestamp).toBe(chunkTs);
    expect(args?.timestamp).toBe(chunkTs);
    expect(end?.timestamp).toBe(chunkTs);
    expect(result?.timestamp).toBe(resultTs);
  });

  it("stamps synthesised TOOL_CALL_RESULT with the chunk row's ts (fallback for missing result row)", async () => {
    // frontend-tool case: no tool_call_result row in DB. The
    // synthesised RESULT inherits the chunk row's ts so duration
    // falls back to 0 ms (best-effort lower bound) rather than to
    // wall-clock-Date.now() drift on replay.
    const run = makeRun();
    const evs = [
      makeEvent(run.id, 3, "tool_call_chunk", {
        toolCallId: "call-synth",
        toolName: "render_chart",
        args: '{"chartId":"x"}',
      }),
    ];
    stageQueries([run], evs);

    const out = await collect("thread-1", "user-1");

    const expectedTs = new Date("2024-01-01T00:00:03Z").getTime();
    const synth = out.find(
      (e) =>
        e.type === EventType.TOOL_CALL_RESULT &&
        (e as unknown as { messageId: string }).messageId.startsWith("synth."),
    ) as { timestamp?: number } | undefined;
    expect(synth?.timestamp).toBe(expectedTs);
  });
});

// endregion

// region: schema validity

describe("reconstructFromDb — emitted events pass EventSchemas validation", () => {
  it("every event in a representative thread parses against the AG-UI union", async () => {
    const run = makeRun();
    const evs = [
      makeEvent(run.id, 0, "message", {
        messageId: "msg-1",
        role: "assistant",
        text: "Computing chart…",
      }),
      makeEvent(run.id, 1, "tool_call_chunk", {
        toolCallId: "call-1",
        toolName: "render_chart",
        args: '{"chartId":"sales-pie"}',
      }),
      // no matching result → triggers synthesis
      makeEvent(run.id, 2, "message", {
        messageId: "msg-2",
        role: "assistant",
        text: "Done.",
      }),
      makeEvent(run.id, 3, "reasoning", {
        messageId: "r1",
        text: "Picking pie type",
      }),
    ];
    stageQueries([run], evs);

    const out = await collect("thread-1", "user-1");

    for (const ev of out) {
      const parsed = EventSchemas.safeParse(ev);
      if (!parsed.success) {
        throw new Error(
          `Event failed schema parse: type=${(ev as { type: string }).type}, ` +
            `issues=${JSON.stringify(parsed.error.issues)}`,
        );
      }
    }
  });
});

// endregion

// region: synthesizer unit test (no DB)

describe("synthesizeToolCallResult", () => {
  // Canonical shapes — kept as named constants so each test states
  // its expected envelope without re-typing the literal.
  const WARNING_MESSAGE = "No tool result was recorded — outcome inferred.";
  const ERROR_MESSAGE = "Run aborted before this tool completed.";

  it("returns an error-severity envelope for non-succeeded runs", () => {
    const result = synthesizeToolCallResult(
      { toolCallId: "id", toolName: "render_chart", args: '{"chartId":"x"}' },
      "cancelled",
    );
    expect(JSON.parse(result.content)).toEqual({
      isError: true,
      severity: "error",
      message: ERROR_MESSAGE,
    });
  });

  it("returns a warning-severity envelope with chartId for render_chart on succeeded runs", () => {
    const result = synthesizeToolCallResult(
      { toolCallId: "id", toolName: "render_chart", args: '{"chartId":"abc"}' },
      "succeeded",
    );
    expect(JSON.parse(result.content)).toEqual({
      isError: true,
      severity: "warning",
      message: WARNING_MESSAGE,
      chartId: "abc",
    });
  });

  it("falls back to a generic warning envelope when render_chart args are malformed", () => {
    const result = synthesizeToolCallResult(
      { toolCallId: "id", toolName: "render_chart", args: "not-json" },
      "succeeded",
    );
    expect(JSON.parse(result.content)).toEqual({
      isError: true,
      severity: "warning",
      message: WARNING_MESSAGE,
    });
  });

  it("returns a generic warning envelope for tools without a per-tool case", () => {
    const result = synthesizeToolCallResult(
      { toolCallId: "id", toolName: "render_html", args: '{"htmlId":"q"}' },
      "succeeded",
    );
    expect(JSON.parse(result.content)).toEqual({
      isError: true,
      severity: "warning",
      message: WARNING_MESSAGE,
    });
  });

  it("always carries a messageId prefixed with 'synth.'", () => {
    const result = synthesizeToolCallResult(
      { toolCallId: "tc1", toolName: "render_chart", args: '{"chartId":"y"}' },
      "succeeded",
    );
    expect(result.messageId).toBe("synth.tc1");
    expect(result.role).toBe("tool");
  });
});

// endregion
