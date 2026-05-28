import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { EventType } = await import("@/lib/copilot/index.server");
type AgUiEvent = import("@/lib/copilot/index.server").AgUiEvent;

/**
 * This file is primarily a *compile-time* check that the
 * {@link AgUiEvent} discriminated union narrows correctly on
 * `event.type` (using {@link EventType} as the discriminant). If
 * any case below regressed to needing `as` to access a per-event
 * field, the file would fail tsc — vitest is just the runner that
 * also gives us a tiny runtime sanity assertion.
 *
 * @see docs/runner-events.md §11
 */

/** Per-event field access via switch narrowing — no casts allowed. */
function describeEvent(event: AgUiEvent): string {
  switch (event.type) {
    case EventType.RUN_STARTED:
      return `run-started threadId=${event.threadId} runId=${event.runId}`;
    case EventType.RUN_FINISHED:
      return `run-finished runId=${event.runId}`;
    case EventType.RUN_ERROR:
      return `run-error message=${event.message}`;
    case EventType.TEXT_MESSAGE_START:
      return `text-start ${event.messageId} role=${event.role}`;
    case EventType.TEXT_MESSAGE_CONTENT:
      return `text-content ${event.messageId} delta=${event.delta}`;
    case EventType.TEXT_MESSAGE_END:
      return `text-end ${event.messageId}`;
    case EventType.TEXT_MESSAGE_CHUNK:
      return `text-chunk delta=${event.delta ?? ""}`;
    case EventType.TOOL_CALL_START:
      return `tool-start ${event.toolCallId} name=${event.toolCallName}`;
    case EventType.TOOL_CALL_ARGS:
      return `tool-args ${event.toolCallId} delta=${event.delta}`;
    case EventType.TOOL_CALL_END:
      return `tool-end ${event.toolCallId}`;
    case EventType.TOOL_CALL_RESULT:
      return `tool-result ${event.toolCallId}`;
    case EventType.TOOL_CALL_CHUNK:
      return `tool-chunk`;
    case EventType.REASONING_START:
      return `reasoning-start`;
    case EventType.REASONING_END:
      return `reasoning-end`;
    case EventType.REASONING_MESSAGE_START:
      return `reasoning-msg-start ${event.messageId}`;
    case EventType.REASONING_MESSAGE_CONTENT:
      return `reasoning-msg-content ${event.messageId} delta=${event.delta}`;
    case EventType.REASONING_MESSAGE_END:
      return `reasoning-msg-end ${event.messageId}`;
    case EventType.REASONING_MESSAGE_CHUNK:
      return `reasoning-msg-chunk`;
    case EventType.STEP_STARTED:
      return `step-started ${event.stepName}`;
    case EventType.STEP_FINISHED:
      return `step-finished ${event.stepName}`;
    case EventType.CUSTOM:
      return `custom name=${event.name}`;
    case EventType.RAW:
      return `raw event=${JSON.stringify(event.event)}`;
    default: {
      // Exhaustiveness check: if a new variant is added to AgUiEvent
      // without a matching case here, tsc fails on this assignment.
      const _exhaustive: never = event;
      void _exhaustive;
      return "unreachable";
    }
  }
}

describe("AgUiEvent union", () => {
  it("narrows RUN_STARTED via EventType enum discriminant", () => {
    const ev: AgUiEvent = {
      type: EventType.RUN_STARTED,
      threadId: "t1",
      runId: "r1",
    };
    expect(describeEvent(ev)).toBe("run-started threadId=t1 runId=r1");
  });

  it("narrows TEXT_MESSAGE_CONTENT and exposes `delta`", () => {
    const ev: AgUiEvent = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "m1",
      delta: "hello",
    };
    expect(describeEvent(ev)).toBe("text-content m1 delta=hello");
  });

  it("narrows TOOL_CALL_START and exposes `toolCallName`", () => {
    const ev: AgUiEvent = {
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc1",
      toolCallName: "extract_dataset_by_sql",
    };
    expect(describeEvent(ev)).toBe(
      "tool-start tc1 name=extract_dataset_by_sql",
    );
  });

  it("narrows RUN_ERROR and exposes `message`", () => {
    const ev: AgUiEvent = {
      type: EventType.RUN_ERROR,
      message: "boom",
    };
    expect(describeEvent(ev)).toBe("run-error message=boom");
  });
});
