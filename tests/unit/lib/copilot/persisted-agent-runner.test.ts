import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY, of } from "rxjs";

vi.mock("server-only", () => ({}));

// ---- Stub the persistence helpers / lower layer ----

// PersistingAgent: capture constructor args; produce an object whose
// `inner` field is the wrapped agent so `runMock` can assert on it.
// Also expose the AbstractAgent state-mutation surface (setMessages /
// setState / threadId) so tests can assert that `run()` copies the
// inner agent's state across the wrap boundary.
const persistingAgentCtor = vi.fn();
vi.mock("@/lib/runner/persisting-agent", () => ({
  PersistingAgent: class StubPersistingAgent {
    public readonly cfg: unknown;
    public messages: unknown[] = [];
    public state: unknown = {};
    public threadId: string | undefined;
    constructor(cfg: unknown) {
      this.cfg = cfg;
      persistingAgentCtor(cfg);
    }
    setMessages(messages: unknown[]): void {
      this.messages = messages;
    }
    setState(state: unknown): void {
      this.state = state;
    }
  },
}));

// reconstructFromDb: spy so we can assert it gets the right args
// when connect() falls back to DB.
const reconstructFromDbMock = vi.fn();
vi.mock("@/lib/copilot/event-reconstruction", () => ({
  reconstructFromDb: (...args: unknown[]) => reconstructFromDbMock(...args),
}));

// InMemoryAgentRunner: stub all four methods. Crucially the SAME
// instance is constructed inside `new PersistedAgentRunner()`, so we
// share these mocks across the lifecycle.
const innerRunMock = vi.fn();
const innerConnectMock = vi.fn();
const innerIsRunningMock = vi.fn();
const innerStopMock = vi.fn();
vi.mock("@/lib/copilot/index.server", async () => {
  // Re-use real AgentRunner abstract base so `extends` works in the SUT.
  const real = await vi.importActual<typeof import("@/lib/copilot/index.server")>(
    "@/lib/copilot/index.server",
  );
  return {
    ...real,
    InMemoryAgentRunner: class StubInner extends real.AgentRunner {
      run(req: Parameters<typeof innerRunMock>[0]) {
        return innerRunMock(req);
      }
      connect(req: Parameters<typeof innerConnectMock>[0]) {
        return innerConnectMock(req);
      }
      isRunning(req: Parameters<typeof innerIsRunningMock>[0]) {
        return innerIsRunningMock(req);
      }
      stop(req: Parameters<typeof innerStopMock>[0]) {
        return innerStopMock(req);
      }
    },
  };
});

const { PersistedAgentRunner } = await import(
  "@/lib/copilot/persisted-agent-runner"
);

const noopLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as ConstructorParameters<typeof PersistedAgentRunner>[0]["log"];

beforeEach(() => {
  vi.clearAllMocks();
});

// region: run()

describe("PersistedAgentRunner.run()", () => {
  it("throws when constructed without runId", () => {
    const runner = new PersistedAgentRunner({
      ownerId: "u-1",
      log: noopLog,
    });
    expect(() =>
      runner.run({
        threadId: "t-1",
        agent: {} as never,
        input: {} as never,
      }),
    ).toThrowError(/requires `runId`/);
  });

  it("wraps the inner agent with PersistingAgent and delegates", () => {
    const fakeAgent = { name: "raw-agent" };
    const wrappedObservable = of({ type: "RUN_STARTED" } as never);
    innerRunMock.mockReturnValueOnce(wrappedObservable);

    const runner = new PersistedAgentRunner({
      ownerId: "u-1",
      runId: "r-1",
      startSeq: 7,
      log: noopLog,
    });

    const result = runner.run({
      threadId: "t-1",
      agent: fakeAgent as never,
      input: { runId: "r-1" } as never,
    });

    // PersistingAgent constructed with the right config
    expect(persistingAgentCtor).toHaveBeenCalledTimes(1);
    expect(persistingAgentCtor).toHaveBeenCalledWith({
      inner: fakeAgent,
      runId: "r-1",
      startSeq: 7,
    });

    // inner.run() received the *wrapped* agent, not the raw one
    expect(innerRunMock).toHaveBeenCalledTimes(1);
    const innerArg = innerRunMock.mock.calls[0]![0];
    expect(innerArg.threadId).toBe("t-1");
    expect(innerArg.agent).not.toBe(fakeAgent);
    expect((innerArg.agent as { cfg: unknown }).cfg).toEqual({
      inner: fakeAgent,
      runId: "r-1",
      startSeq: 7,
    });

    expect(result).toBe(wrappedObservable);
  });

  it("defaults startSeq to 0 when not provided", () => {
    innerRunMock.mockReturnValueOnce(EMPTY);
    const runner = new PersistedAgentRunner({
      ownerId: "u-1",
      runId: "r-2",
      log: noopLog,
    });
    runner.run({
      threadId: "t-1",
      agent: {} as never,
      input: {} as never,
    });
    expect(persistingAgentCtor.mock.calls[0]![0]).toMatchObject({
      runId: "r-2",
      startSeq: 0,
    });
  });

  it("copies messages/state/threadId from inner agent to wrapped before delegation", () => {
    // CopilotKit's handle-run.ts populates these fields on the agent
    // it hands to the runner. `AbstractAgent.runAgent()` then reads
    // `this.messages` via `prepareRunAgentInput` — ignoring the
    // parameters.messages. If we don't propagate them, the wrapped
    // agent runs with an empty conversation. This test guards that.
    const innerAgent = {
      messages: [{ id: "m1", role: "user", content: "hello" }],
      state: { counter: 7 },
      threadId: "t-from-inner",
    };
    innerRunMock.mockReturnValueOnce(EMPTY);

    const runner = new PersistedAgentRunner({
      ownerId: "u-1",
      runId: "r-3",
      log: noopLog,
    });
    runner.run({
      threadId: "t-1",
      agent: innerAgent as never,
      input: {} as never,
    });

    const innerArg = innerRunMock.mock.calls[0]![0];
    const wrappedAgent = innerArg.agent as {
      messages: unknown;
      state: unknown;
      threadId: string | undefined;
    };
    expect(wrappedAgent.messages).toEqual(innerAgent.messages);
    expect(wrappedAgent.state).toEqual(innerAgent.state);
    expect(wrappedAgent.threadId).toBe("t-from-inner");
  });
});

// endregion

// region: connect()

describe("PersistedAgentRunner.connect()", () => {
  it("always reconstructs from DB; never delegates to inner.connect", async () => {
    // CONTRACT: `connect()` is unconditionally DB-driven. The
    // `inArray(status, [terminal])` filter inside `reconstructFromDb`
    // (see `fetchRuns`) is what excludes in-flight runs; there is no
    // additional top-level skip. An earlier iteration short-circuited
    // to an empty stream while a run was live on the thread, which
    // produced a blank chat after the very first frontend-tool turn —
    // CopilotChat's `connect-on-thread` effect runs
    // `agent.setMessages([])` BEFORE the connect stream emits, and an
    // empty stream left the agent with no messages until something
    // else triggered a re-render. The terminal-only filter inside
    // `reconstructFromDb` is sufficient by itself.
    //
    // @see docs/data-visualization.md §6.4 ("Bug B" diagnosis)
    const dbStream = of({ type: "RUN_STARTED" } as never);
    reconstructFromDbMock.mockReturnValueOnce(dbStream);

    const runner = new PersistedAgentRunner({
      ownerId: "user-42",
      log: noopLog,
    });

    const subscriber = vi.fn();
    await new Promise<void>((resolve) => {
      runner
        .connect({ threadId: "t-7" })
        .subscribe({ next: subscriber, complete: resolve });
    });

    expect(innerConnectMock).not.toHaveBeenCalled();
    expect(innerIsRunningMock).not.toHaveBeenCalled();
    expect(reconstructFromDbMock).toHaveBeenCalledTimes(1);
    expect(reconstructFromDbMock).toHaveBeenCalledWith({
      threadId: "t-7",
      ownerId: "user-42",
      log: noopLog,
    });
    expect(subscriber).toHaveBeenCalledTimes(1);
  });
});

// endregion

// region: delegation

describe("PersistedAgentRunner — delegation passthrough", () => {
  it("isRunning() delegates to inner", async () => {
    innerIsRunningMock.mockResolvedValueOnce(true);
    const runner = new PersistedAgentRunner({
      ownerId: "u",
      log: noopLog,
    });
    await expect(runner.isRunning({ threadId: "t" })).resolves.toBe(true);
    expect(innerIsRunningMock).toHaveBeenCalledWith({ threadId: "t" });
  });

  it("stop() delegates to inner", async () => {
    innerStopMock.mockResolvedValueOnce(true);
    const runner = new PersistedAgentRunner({
      ownerId: "u",
      log: noopLog,
    });
    await expect(runner.stop({ threadId: "t" })).resolves.toBe(true);
    expect(innerStopMock).toHaveBeenCalledWith({ threadId: "t" });
  });
});

// endregion
