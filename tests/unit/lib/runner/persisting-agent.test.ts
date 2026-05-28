/**
 * Tests for `PersistingAgent` — focused on the DB-drain sequencing
 * contract that prevents the "blank chat" regression.
 *
 * Invariant: `subscriber.complete()` (which closes the SSE response)
 * MUST fire only AFTER `recordEvent` + `finalizeRun` writes settle,
 * so a synchronously-reconnecting client sees a consistent timeline
 * via `reconstructFromDb`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Observable, Subject } from "rxjs";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({
  EntityRunTable: {},
  EntityRunEventTable: {},
}));
vi.mock("@/lib/backends/types", () => ({}));

// Deferred-style mocks so tests can control when DB writes settle.
let appendDeferreds: Array<{ resolve: () => void; reject: (e: Error) => void }> =
  [];
let appendCalls: Array<
  [runId: string, seq: number, type: string, payload: unknown, ts?: Date]
> = [];
let finalizeDeferred: {
  resolve: () => void;
  reject: (e: Error) => void;
} | null = null;
let finalizeArgs: { runId: string; status: string; fields: unknown } | null =
  null;

const appendEventMock = vi.fn(
  (
    runId: string,
    seq: number,
    type: string,
    payload: unknown,
    ts?: Date,
  ): Promise<void> => {
    appendCalls.push([runId, seq, type, payload, ts]);
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const p = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    appendDeferreds.push({ resolve, reject });
    return p;
  },
);

const finalizeRunMock = vi.fn(
  (runId: string, status: string, fields: unknown): Promise<void> => {
    finalizeArgs = { runId, status, fields };
    return new Promise<void>((res, rej) => {
      finalizeDeferred = { resolve: res, reject: rej };
    });
  },
);

vi.mock("@/lib/runner/event-store", () => ({
  recordEvent: (
    runId: string,
    seq: number,
    type: string,
    payload: unknown,
    ts?: Date,
  ): Promise<void> => appendEventMock(runId, seq, type, payload, ts),
  finalizeRun: (
    runId: string,
    status: string,
    fields: unknown,
  ): Promise<void> => finalizeRunMock(runId, status, fields),
}));

import {
  AbstractAgent,
  EventType,
  type AgUiEvent,
  type BaseEvent,
  type RunAgentInput,
} from "@/lib/copilot/index.server";
import { PersistingAgent } from "@/lib/runner/persisting-agent";

/** Minimal stand-in for the inner agent contract used by PersistingAgent:
 *  emits the events we push into `subject`. */
class InnerAgent extends AbstractAgent {
  public readonly subject = new Subject<BaseEvent>();
  public run(): Observable<BaseEvent> {
    return this.subject.asObservable();
  }
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

beforeEach(() => {
  appendDeferreds = [];
  appendCalls = [];
  finalizeDeferred = null;
  finalizeArgs = null;
  appendEventMock.mockClear();
  finalizeRunMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PersistingAgent: drain-before-complete sequencing", () => {
  it("does NOT call subscriber.complete until finalizeRun resolves", async () => {
    const inner = new InnerAgent();
    const agent = new PersistingAgent({ inner, runId: "run-1" });

    const next = vi.fn();
    const complete = vi.fn();
    const sub = agent
      .run({
        threadId: "t",
        runId: "run-1",
        tools: [],
        context: [],
        forwardedProps: {},
        state: {},
        messages: [],
      } as unknown as RunAgentInput)
      .subscribe({ next, complete });

    // Drive a minimal run: RUN_STARTED → RUN_FINISHED → inner complete
    inner.subject.next({
      type: EventType.RUN_STARTED,
      threadId: "t",
      runId: "run-1",
    } as unknown as AgUiEvent);
    inner.subject.next({
      type: EventType.RUN_FINISHED,
      threadId: "t",
      runId: "run-1",
    } as unknown as AgUiEvent);
    inner.subject.complete();

    await flush();

    // Inner forwarded 2 events but stream NOT closed yet because the
    // recordEvent promises (and the queued finalizeRun) are pending.
    expect(next).toHaveBeenCalledTimes(2);
    expect(complete).not.toHaveBeenCalled();

    // Settle the queued recordEvent writes — finalizeRun should now fire.
    for (const d of appendDeferreds) d.resolve();
    await flush();
    expect(finalizeRunMock).toHaveBeenCalledTimes(1);
    expect(finalizeArgs?.status).toBe("succeeded");

    // STILL not complete — finalizeRun's UPDATE hasn't settled.
    expect(complete).not.toHaveBeenCalled();

    // Resolve the terminal UPDATE → SSE may close.
    finalizeDeferred!.resolve();
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);

    sub.unsubscribe();
  });

  it("force-closes the stream after the drain timeout if DB hangs", async () => {
    vi.useFakeTimers();
    const inner = new InnerAgent();
    const agent = new PersistingAgent({ inner, runId: "run-2" });

    const complete = vi.fn();
    const sub = agent
      .run({
        threadId: "t",
        runId: "run-2",
        tools: [],
        context: [],
        forwardedProps: {},
        state: {},
        messages: [],
      } as unknown as RunAgentInput)
      .subscribe({ complete });

    inner.subject.next({
      type: EventType.RUN_FINISHED,
      threadId: "t",
      runId: "run-2",
    } as unknown as AgUiEvent);
    inner.subject.complete();

    await Promise.resolve();
    // Resolve the append so we're definitely blocked on finalizeRun.
    for (const d of appendDeferreds) d.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(complete).not.toHaveBeenCalled();

    // 5s timeout drives the close path even though finalizeRun never resolved.
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();

    expect(complete).toHaveBeenCalledTimes(1);

    sub.unsubscribe();
  });

  it("captures start-time ts for coalesced rows, not END time", async () => {
    const inner = new InnerAgent();
    const agent = new PersistingAgent({ inner, runId: "run-ts" });

    const sub = agent
      .run({
        threadId: "t",
        runId: "run-ts",
        tools: [],
        context: [],
        forwardedProps: {},
        state: {},
        messages: [],
      } as unknown as RunAgentInput)
      .subscribe();

    // Simulate a 100ms streaming window:
    // START at T0 → CONTENT/CONTENT → END at T0+100ms.
    // The persisted `message` row's ts MUST be ~T0, not T0+100ms.
    inner.subject.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m1",
      role: "assistant",
    } as unknown as AgUiEvent);
    const tStart = Date.now();

    await new Promise((r) => setTimeout(r, 100));

    inner.subject.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "m1",
      delta: "hello",
    } as unknown as AgUiEvent);
    inner.subject.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "m1",
    } as unknown as AgUiEvent);

    await flush();

    const messageCall = appendCalls.find((c) => c[2] === "message");
    expect(messageCall).toBeDefined();
    const ts = messageCall![4];
    expect(ts).toBeInstanceOf(Date);
    // ts should be at START time (within a few ms), not END (+100ms).
    const drift = Math.abs(ts!.getTime() - tStart);
    expect(drift).toBeLessThan(30);

    sub.unsubscribe();
  });

  it("uses 'cancelled' status on unsubscribe before completion", async () => {
    const inner = new InnerAgent();
    const agent = new PersistingAgent({ inner, runId: "run-3" });

    const sub = agent
      .run({
        threadId: "t",
        runId: "run-3",
        tools: [],
        context: [],
        forwardedProps: {},
        state: {},
        messages: [],
      } as unknown as RunAgentInput)
      .subscribe();

    inner.subject.next({
      type: EventType.RUN_STARTED,
      threadId: "t",
      runId: "run-3",
    } as unknown as AgUiEvent);

    sub.unsubscribe();
    await flush();
    for (const d of appendDeferreds) d.resolve();
    await flush();

    expect(finalizeRunMock).toHaveBeenCalledTimes(1);
    expect(finalizeArgs?.status).toBe("cancelled");
  });
});
