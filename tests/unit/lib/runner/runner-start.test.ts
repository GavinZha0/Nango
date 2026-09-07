import { describe, it, expect, vi, beforeEach } from "vitest";

const { recordRunStartMock, finalizeRunMock, recordEventMock } = vi.hoisted(() => ({
  recordRunStartMock: vi.fn(),
  finalizeRunMock: vi.fn().mockResolvedValue(undefined),
  recordEventMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/runner/event-store", () => ({
  recordRunStart: recordRunStartMock,
  finalizeRun: finalizeRunMock,
  recordEvent: recordEventMock,
}));

vi.mock("@/lib/observability/langfuse", () => ({
  withTrace: vi.fn((_opts, fn) => fn(null)),
  flushLangfuse: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/access/agent-visibility", () => ({
  isAgentVisibleTo: vi.fn().mockResolvedValue(false),
  listVisibleAgentIds: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/backends/registry.server", () => ({
  getChatHandler: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/credentials/lookup", () => ({
  getCredentialConfigById: vi.fn().mockResolvedValue({ provider: "unknown_provider" }),
  onCredentialCacheInvalidated: vi.fn(),
}));

const { buildBuiltinAgentsMock } = vi.hoisted(() => ({
  buildBuiltinAgentsMock: vi.fn(),
}));

vi.mock("@/lib/runner/dispatch/builtin", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/runner/dispatch/builtin")
  >();
  return {
    ...actual,
    buildBuiltinAgents: buildBuiltinAgentsMock,
  };
});

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    db: {
      select: vi.fn(),
    },
  };
});

// ---------------------------------------------------------------------------
// Additional mocks for runChatRequest / runBuiltinChatRequest / start paths.
// ---------------------------------------------------------------------------

const {
  runWithAgentsMock,
  getConfigMsMock,
  recordRunNotificationMock,
  previewBodyMock,
  publishMock,
  extractRunInputMock,
  injectServerUserIdMock,
  resolveTranscriptionServiceMock,
  resolveOrchestrationModeMock,
  persistingAgentCtorMock,
  persistedAgentRunnerCtorMock,
  builtInAgentCtorMock,
} = vi.hoisted(() => ({
  runWithAgentsMock: vi.fn(),
  getConfigMsMock: vi.fn(),
  recordRunNotificationMock: vi.fn().mockResolvedValue(undefined),
  previewBodyMock: vi.fn((t: string | null | undefined) => t ?? null),
  publishMock: vi.fn(),
  extractRunInputMock: vi.fn(),
  injectServerUserIdMock: vi.fn((req: Request) => req),
  resolveTranscriptionServiceMock: vi.fn().mockResolvedValue(undefined),
  resolveOrchestrationModeMock: vi.fn().mockReturnValue({ id: "default" }),
  persistingAgentCtorMock: vi.fn(),
  persistedAgentRunnerCtorMock: vi.fn(),
  builtInAgentCtorMock: vi.fn().mockImplementation(
    function (cfg: unknown) {
      return Object.assign({}, cfg, { __stub: true });
    } as never,
  ),
}));

vi.mock("@/lib/backends/runtime.server", () => ({
  runWithAgents: runWithAgentsMock,
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    getConfigMs: getConfigMsMock,
  };
});

vi.mock("@/lib/runner/notifications", () => ({
  recordRunNotification: recordRunNotificationMock,
  previewBody: previewBodyMock,
}));

vi.mock("@/lib/runner/event-bus", () => ({
  publish: publishMock,
}));

vi.mock("@/lib/runner/extract-run-input", () => ({
  extractRunInput: extractRunInputMock,
  extractRunInputFromBody: vi.fn(),
  extractTrailingToolResults: vi.fn(),
  stringifyToolContent: vi.fn(),
  formatPageContextSnapshot: vi.fn(),
}));

vi.mock("@/lib/runner/inject-user-id", () => ({
  injectServerUserId: injectServerUserIdMock,
}));

vi.mock("@/lib/copilot/persisted-agent-runner", () => ({
  PersistedAgentRunner: persistedAgentRunnerCtorMock,
}));

vi.mock("@/lib/runner/persisting-agent", () => ({
  PersistingAgent: persistingAgentCtorMock,
}));

vi.mock("@/lib/voice/transcription.server", () => ({
  resolveTranscriptionService: resolveTranscriptionServiceMock,
}));

vi.mock("@/lib/orchestration/modes", () => ({
  ORCHESTRATION_MODE_HEADER: "x-orchestration-mode",
  resolveOrchestrationMode: resolveOrchestrationModeMock,
}));

vi.mock("@/lib/copilot/index.server", () => ({
  EventType: {
    TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
    TEXT_MESSAGE_CHUNK: "TEXT_MESSAGE_CHUNK",
    RUN_ERROR: "RUN_ERROR",
    RUN_STARTED: "RUN_STARTED",
    RUN_FINISHED: "RUN_FINISHED",
    TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
    TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
    TOOL_CALL_START: "TOOL_CALL_START",
    TOOL_CALL_END: "TOOL_CALL_END",
    TOOL_CALL_CHUNK: "TOOL_CALL_CHUNK",
    TOOL_CALL_RESULT: "TOOL_CALL_RESULT",
    STEP_STARTED: "STEP_STARTED",
    STEP_FINISHED: "STEP_FINISHED",
    RAW: "RAW",
  },
  BuiltInAgent: builtInAgentCtorMock,
  AbstractAgent: class AbstractAgent {},
  defineTool: (def: unknown) => def,
}));

import { runner } from "@/lib/runner";

describe("Runner — Execution Kernel & Lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Helpers for the extended coverage tests below.
  // =========================================================================
  function defaultRunStart() {
    return { id: "run-test-1", startedAt: new Date("2026-01-01T00:00:00Z") };
  }

  async function setupChatHandler(buildAgentImpl: () => Promise<unknown>) {
    const { getChatHandler } = await import("@/lib/backends/registry.server");
    const handler = { buildAgent: vi.fn(buildAgentImpl) };
    vi.mocked(getChatHandler).mockReturnValue(handler as never);
    return handler;
  }

  async function setupDbSelectLimit(rows: unknown[]) {
    const { db } = await import("@/lib/db");
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
    } as never);
  }

  /** PersistingAgent mock whose subscribe fires complete on a microtask. */
  function persistingAgentImmediateComplete() {
    persistingAgentCtorMock.mockImplementation(
      function (cfg: unknown) {
        return {
          cfg,
          run: () => ({
            subscribe: (handlers: { complete?: () => void }) => {
              queueMicrotask(() => handlers.complete?.());
              return { unsubscribe: () => {} };
            },
          }),
        };
      } as never,
    );
  }

  /** PersistingAgent mock whose subscribe never fires (for timeout tests). */
  function persistingAgentHanging() {
    persistingAgentCtorMock.mockImplementation(
      function (cfg: unknown) {
        return {
          cfg,
          run: () => ({
            subscribe: () => ({ unsubscribe: () => {} }),
          }),
        };
      } as never,
    );
  }

  function builtinAgentResult(agentId: string, agent: unknown) {
    return {
      agents: { [agentId]: agent },
      borrowed: [],
      degradations: new Map(),
      supervisorRunHolders: new Map(),
    };
  }

  // =========================================================================
  // =========================================================================
  // runner.start — sync mode
  // =========================================================================
  describe("runner.start — sync mode", () => {
    it("returns succeeded ProgrammaticRunResult on successful completion", async () => {
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      getConfigMsMock.mockReturnValue(300000);
      await setupDbSelectLimit([{ role: "editor" }]);
      buildBuiltinAgentsMock.mockResolvedValue(
        builtinAgentResult("agent-1", { __agent: "stub" }),
      );
      persistingAgentImmediateComplete();

      const result = await runner.start({
        mode: "sync",
        entityId: "agent-1",
        ownerId: "user-1",
        task: "do work",
        initiator: "user",
        createdBy: "user-1",
      });

      expect(result.runId).toBe("run-test-1");
      expect(result.status).toBe("succeeded");
      expect(result.summary).toBe("");
      expect(recordRunStartMock).toHaveBeenCalledTimes(1);
      expect(recordRunStartMock).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: "agent-1",
          entityKind: "agent",
          entitySource: "builtin",
          mode: "sync",
        }),
      );
    });

    it("accumulates TEXT_MESSAGE_CONTENT and TEXT_MESSAGE_CHUNK deltas into summary", async () => {
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      getConfigMsMock.mockReturnValue(300000);
      await setupDbSelectLimit([{ role: "editor" }]);
      buildBuiltinAgentsMock.mockResolvedValue(
        builtinAgentResult("agent-1", { __agent: "stub" }),
      );
      persistingAgentCtorMock.mockImplementation(
        function (cfg: unknown) {
          return {
            cfg,
            run: () => ({
              subscribe: (handlers: {
                next?: (e: unknown) => void;
                complete?: () => void;
              }) => {
                queueMicrotask(() => {
                  handlers.next?.({ type: "TEXT_MESSAGE_CONTENT", delta: "Hello " });
                  handlers.next?.({ type: "TEXT_MESSAGE_CHUNK", delta: "world" });
                  handlers.complete?.();
                });
                return { unsubscribe: () => {} };
              },
            }),
          };
        } as never,
      );

      const result = await runner.start({
        mode: "sync",
        entityId: "agent-1",
        ownerId: "user-1",
        task: "do work",
        initiator: "user",
        createdBy: "user-1",
      });

      expect(result.status).toBe("succeeded");
      expect(result.summary).toBe("Hello world");
    });

    it("captures RUN_ERROR event message as errorMessage on complete", async () => {
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      getConfigMsMock.mockReturnValue(300000);
      await setupDbSelectLimit([{ role: "editor" }]);
      buildBuiltinAgentsMock.mockResolvedValue(
        builtinAgentResult("agent-1", { __agent: "stub" }),
      );
      persistingAgentCtorMock.mockImplementation(
        function (cfg: unknown) {
          return {
            cfg,
            run: () => ({
              subscribe: (handlers: {
                next?: (e: unknown) => void;
                complete?: () => void;
              }) => {
                queueMicrotask(() => {
                  handlers.next?.({ type: "RUN_ERROR", message: "model overloaded" });
                  handlers.complete?.();
                });
                return { unsubscribe: () => {} };
              },
            }),
          };
        } as never,
      );

      const result = await runner.start({
        mode: "sync",
        entityId: "agent-1",
        ownerId: "user-1",
        task: "do work",
        initiator: "user",
        createdBy: "user-1",
      });

      expect(result.status).toBe("failed");
      expect(result.errorMessage).toBe("model overloaded");
    });

    it("returns failed result when agent stream errors", async () => {
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      getConfigMsMock.mockReturnValue(300000);
      await setupDbSelectLimit([{ role: "editor" }]);
      buildBuiltinAgentsMock.mockResolvedValue(
        builtinAgentResult("agent-1", { __agent: "stub" }),
      );
      persistingAgentCtorMock.mockImplementation(
        function (cfg: unknown) {
          return {
            cfg,
            run: () => ({
              subscribe: (handlers: { error?: (e: unknown) => void }) => {
                queueMicrotask(() => handlers.error?.(new Error("agent stream broke")));
                return { unsubscribe: () => {} };
              },
            }),
          };
        } as never,
      );

      const result = await runner.start({
        mode: "sync",
        entityId: "agent-1",
        ownerId: "user-1",
        task: "do work",
        initiator: "user",
        createdBy: "user-1",
      });

      expect(result.runId).toBe("run-test-1");
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toBe("agent stream broke");
    });

    it("finalizes run as failed and rethrows when agent build fails", async () => {
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      await setupDbSelectLimit([]);
      buildBuiltinAgentsMock.mockResolvedValue({
        agents: {},
        borrowed: [],
        degradations: new Map(),
        supervisorRunHolders: new Map(),
      });

      await expect(
        runner.start({
          mode: "sync",
          entityId: "agent-1",
          ownerId: "user-1",
          task: "do work",
          initiator: "user",
          createdBy: "user-1",
        }),
      ).rejects.toThrow(/could not be resolved/);

      expect(finalizeRunMock).toHaveBeenCalledWith(
        "run-test-1",
        "failed",
        expect.objectContaining({
          errorMessage: expect.stringContaining("agent_build_threw"),
        }),
      );
    });

    it("returns failed result on timeout (default 300s)", async () => {
      vi.useFakeTimers();
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      getConfigMsMock.mockReturnValue(1000);
      await setupDbSelectLimit([{ role: "editor" }]);
      buildBuiltinAgentsMock.mockResolvedValue(
        builtinAgentResult("agent-1", { __agent: "stub" }),
      );
      persistingAgentHanging();

      const startPromise = runner.start({
        mode: "sync",
        entityId: "agent-1",
        ownerId: "user-1",
        task: "do work",
        initiator: "user",
        createdBy: "user-1",
      });

      await vi.advanceTimersByTimeAsync(1000);
      const result = await startPromise;

      expect(result.runId).toBe("run-test-1");
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toMatch(/Sync run timed out after 1s/);
      expect(finalizeRunMock).toHaveBeenCalledWith(
        "run-test-1",
        "failed",
        expect.objectContaining({
          errorMessage: expect.stringContaining("Sync run timed out"),
        }),
      );
      vi.useRealTimers();
    });

    it("with credentialId dispatches as backend entity source", async () => {
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      getConfigMsMock.mockReturnValue(300000);
      await setupChatHandler(async () => ({ __agent: "backend-stub" }));
      persistingAgentImmediateComplete();

      const result = await runner.start({
        mode: "sync",
        entityId: "backend-agent-1",
        entityKind: "agent",
        credentialId: "cred-1",
        ownerId: "user-1",
        task: "do work",
        initiator: "user",
        createdBy: "user-1",
      });

      expect(result.status).toBe("succeeded");
      expect(recordRunStartMock).toHaveBeenCalledWith(
        expect.objectContaining({
          entitySource: "backend",
          credentialId: "cred-1",
        }),
      );
    });

    it("with credentialId throws when no chat handler registered", async () => {
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      // Reset getChatHandler to null (prior tests may have overridden it).
      const { getChatHandler } = await import("@/lib/backends/registry.server");
      vi.mocked(getChatHandler).mockReturnValue(null);

      await expect(
        runner.start({
          mode: "sync",
          entityId: "backend-agent-1",
          entityKind: "agent",
          credentialId: "cred-1",
          ownerId: "user-1",
          task: "do work",
          initiator: "user",
          createdBy: "user-1",
        }),
      ).rejects.toThrow(/no chat handler/);

      expect(finalizeRunMock).toHaveBeenCalledWith(
        "run-test-1",
        "failed",
        expect.objectContaining({
          errorMessage: expect.stringContaining("agent_build_threw"),
        }),
      );
    });

    it("with credentialId throws when handler.buildAgent returns a Response", async () => {
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      const errorResponse = new Response("bad config", { status: 400 });
      await setupChatHandler(async () => errorResponse);

      await expect(
        runner.start({
          mode: "sync",
          entityId: "backend-agent-1",
          entityKind: "agent",
          credentialId: "cred-1",
          ownerId: "user-1",
          task: "do work",
          initiator: "user",
          createdBy: "user-1",
        }),
      ).rejects.toThrow(/build failed: 400/);

      expect(finalizeRunMock).toHaveBeenCalledWith(
        "run-test-1",
        "failed",
        expect.objectContaining({
          errorMessage: expect.stringContaining("agent_build_threw"),
        }),
      );
    });

    it("throws with fallback reason when builtin agent missing and no degradation", async () => {
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      await setupDbSelectLimit([{ role: "user" }]);
      buildBuiltinAgentsMock.mockResolvedValue({
        agents: {},
        borrowed: [],
        degradations: new Map(),
        supervisorRunHolders: new Map(),
      });

      await expect(
        runner.start({
          mode: "sync",
          entityId: "ghost-agent",
          ownerId: "user-1",
          task: "do work",
          initiator: "user",
          createdBy: "user-1",
        }),
      ).rejects.toThrow(/disabled, missing credential, or unsupported model/);
    });

    it("throws with degradation reason when builtin agent missing with degradation", async () => {
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      await setupDbSelectLimit([{ role: "user" }]);
      buildBuiltinAgentsMock.mockResolvedValue({
        agents: {},
        borrowed: [],
        degradations: new Map([
          [
            "ghost-agent",
            [
              {
                ref: "ghost-agent",
                refName: null,
                reason: "spec_skip",
                message: "Agent spec unavailable",
              },
            ],
          ],
        ]),
        supervisorRunHolders: new Map(),
      });

      await expect(
        runner.start({
          mode: "sync",
          entityId: "ghost-agent",
          ownerId: "user-1",
          task: "do work",
          initiator: "user",
          createdBy: "user-1",
        }),
      ).rejects.toThrow(/Agent spec unavailable/);
    });

    it("handles non-Error throw from agent stream (String(err) fallback)", async () => {
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      getConfigMsMock.mockReturnValue(300000);
      await setupDbSelectLimit([{ role: "editor" }]);
      buildBuiltinAgentsMock.mockResolvedValue(
        builtinAgentResult("agent-1", { __agent: "stub" }),
      );
      persistingAgentCtorMock.mockImplementation(
        function (cfg: unknown) {
          return {
            cfg,
            run: () => ({
              subscribe: (handlers: { error?: (e: unknown) => void }) => {
                queueMicrotask(() => handlers.error?.("string error"));
                return { unsubscribe: () => {} };
              },
            }),
          };
        } as never,
      );

      const result = await runner.start({
        mode: "sync",
        entityId: "agent-1",
        ownerId: "user-1",
        task: "do work",
        initiator: "user",
        createdBy: "user-1",
      });

      expect(result.status).toBe("failed");
      expect(result.errorMessage).toBe("string error");
    });

    it("ignores non-string delta on TEXT_MESSAGE_CONTENT events", async () => {
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      getConfigMsMock.mockReturnValue(300000);
      await setupDbSelectLimit([{ role: "editor" }]);
      buildBuiltinAgentsMock.mockResolvedValue(
        builtinAgentResult("agent-1", { __agent: "stub" }),
      );
      persistingAgentCtorMock.mockImplementation(
        function (cfg: unknown) {
          return {
            cfg,
            run: () => ({
              subscribe: (handlers: {
                next?: (e: unknown) => void;
                complete?: () => void;
              }) => {
                queueMicrotask(() => {
                  // delta is a number, not a string — must be ignored.
                  handlers.next?.({ type: "TEXT_MESSAGE_CONTENT", delta: 42 });
                  handlers.complete?.();
                });
                return { unsubscribe: () => {} };
              },
            }),
          };
        } as never,
      );

      const result = await runner.start({
        mode: "sync",
        entityId: "agent-1",
        ownerId: "user-1",
        task: "do work",
        initiator: "user",
        createdBy: "user-1",
      });

      expect(result.status).toBe("succeeded");
      expect(result.summary).toBe("");
    });
  });

  // =========================================================================
  // runner.start — async mode
  // =========================================================================
  describe("runner.start — async mode", () => {
    it("returns runId with status running immediately and publishes run_started", async () => {
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      getConfigMsMock.mockReturnValue(1800000);
      buildBuiltinAgentsMock.mockResolvedValue(
        builtinAgentResult("agent-1", { __agent: "stub" }),
      );
      persistingAgentHanging();
      await setupDbSelectLimit([{ role: "editor", name: "Test Agent" }]);

      const result = await runner.start({
        mode: "async",
        entityId: "agent-1",
        ownerId: "user-1",
        task: "do work",
        initiator: "user",
        createdBy: "user-1",
      });

      expect(result.runId).toBe("run-test-1");
      expect(result.status).toBe("running");
      expect(result.summary).toBe("");
      expect(recordRunStartMock).toHaveBeenCalledTimes(1);
      expect(publishMock).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          kind: "run_started",
          runId: "run-test-1",
          ownerId: "user-1",
          entityId: "Test Agent",
        }),
      );
    });

    it("publishes run_finalized and records notification on stream complete", async () => {
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      getConfigMsMock.mockReturnValue(1800000);
      await setupDbSelectLimit([{ role: "editor" }]);
      buildBuiltinAgentsMock.mockResolvedValue(
        builtinAgentResult("agent-1", { __agent: "stub" }),
      );
      let subscribeHandlers: {
        next?: (e: unknown) => void;
        error?: (e: unknown) => void;
        complete?: () => void;
      } = {};
      persistingAgentCtorMock.mockImplementation(
        function (cfg: unknown) {
          return {
            cfg,
            run: () => ({
              subscribe: (handlers: typeof subscribeHandlers) => {
                subscribeHandlers = handlers;
                return { unsubscribe: () => {} };
              },
            }),
          };
        } as never,
      );
      await setupDbSelectLimit([]);

      await runner.start({
        mode: "async",
        entityId: "agent-1",
        ownerId: "user-1",
        task: "do work",
        initiator: "user",
        createdBy: "user-1",
      });

      subscribeHandlers.next?.({ type: "TEXT_MESSAGE_CONTENT", delta: "done" });
      subscribeHandlers.complete?.();
      // Flush the void recordRunNotification microtask.
      await new Promise((r) => setImmediate(r));

      expect(publishMock).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          kind: "run_finalized",
          status: "succeeded",
        }),
      );
      expect(recordRunNotificationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: "user-1",
          runId: "run-test-1",
          kind: "run_completed",
          title: "Async task completed",
        }),
      );
    });

    it("publishes failed run_finalized and records notification on stream error", async () => {
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      getConfigMsMock.mockReturnValue(1800000);
      await setupDbSelectLimit([{ role: "editor" }]);
      buildBuiltinAgentsMock.mockResolvedValue(
        builtinAgentResult("agent-1", { __agent: "stub" }),
      );
      let subscribeHandlers: {
        next?: (e: unknown) => void;
        error?: (e: unknown) => void;
        complete?: () => void;
      } = {};
      persistingAgentCtorMock.mockImplementation(
        function (cfg: unknown) {
          return {
            cfg,
            run: () => ({
              subscribe: (handlers: typeof subscribeHandlers) => {
                subscribeHandlers = handlers;
                return { unsubscribe: () => {} };
              },
            }),
          };
        } as never,
      );
      await setupDbSelectLimit([]);

      await runner.start({
        mode: "async",
        entityId: "agent-1",
        ownerId: "user-1",
        task: "do work",
        initiator: "user",
        createdBy: "user-1",
      });

      subscribeHandlers.error?.(new Error("background failure"));
      await new Promise((r) => setImmediate(r));

      expect(publishMock).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          kind: "run_finalized",
          status: "failed",
        }),
      );
      expect(recordRunNotificationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "run_failed",
          title: "Async task failed",
        }),
      );
    });

    it("captures RUN_ERROR event then complete as failed with notification", async () => {
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      getConfigMsMock.mockReturnValue(1800000);
      await setupDbSelectLimit([{ role: "editor" }]);
      buildBuiltinAgentsMock.mockResolvedValue(
        builtinAgentResult("agent-1", { __agent: "stub" }),
      );
      let subscribeHandlers: {
        next?: (e: unknown) => void;
        error?: (e: unknown) => void;
        complete?: () => void;
      } = {};
      persistingAgentCtorMock.mockImplementation(
        function (cfg: unknown) {
          return {
            cfg,
            run: () => ({
              subscribe: (handlers: typeof subscribeHandlers) => {
                subscribeHandlers = handlers;
                return { unsubscribe: () => {} };
              },
            }),
          };
        } as never,
      );

      await runner.start({
        mode: "async",
        entityId: "agent-1",
        ownerId: "user-1",
        task: "do work",
        initiator: "user",
        createdBy: "user-1",
      });

      subscribeHandlers.next?.({ type: "RUN_ERROR", message: "model overloaded" });
      subscribeHandlers.complete?.();
      await new Promise((r) => setImmediate(r));

      expect(publishMock).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          kind: "run_finalized",
          status: "failed",
        }),
      );
      expect(recordRunNotificationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "run_failed",
          title: "Async task failed",
        }),
      );
    });

    it("publishes failed notification on timeout (default 1800s)", async () => {
      vi.useFakeTimers();
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      getConfigMsMock.mockReturnValue(2000);
      await setupDbSelectLimit([{ role: "editor" }]);
      buildBuiltinAgentsMock.mockResolvedValue(
        builtinAgentResult("agent-1", { __agent: "stub" }),
      );
      persistingAgentHanging();
      await setupDbSelectLimit([]);

      await runner.start({
        mode: "async",
        entityId: "agent-1",
        ownerId: "user-1",
        task: "do work",
        initiator: "user",
        createdBy: "user-1",
      });

      await vi.advanceTimersByTimeAsync(2000);

      expect(publishMock).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          kind: "run_finalized",
          status: "failed",
          preview: expect.stringContaining("Async run timed out"),
        }),
      );
      expect(recordRunNotificationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "run_failed",
          title: "Async task timed out",
        }),
      );
      expect(finalizeRunMock).toHaveBeenCalledWith(
        "run-test-1",
        "failed",
        expect.objectContaining({
          errorMessage: expect.stringContaining("Async run timed out"),
        }),
      );
      vi.useRealTimers();
    });

    it("finalizes run as failed and rethrows when agent build fails", async () => {
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      await setupDbSelectLimit([]);
      buildBuiltinAgentsMock.mockResolvedValue({
        agents: {},
        borrowed: [],
        degradations: new Map(),
        supervisorRunHolders: new Map(),
      });
      await setupDbSelectLimit([]);

      await expect(
        runner.start({
          mode: "async",
          entityId: "agent-1",
          ownerId: "user-1",
          task: "do work",
          initiator: "user",
          createdBy: "user-1",
        }),
      ).rejects.toThrow(/could not be resolved/);

      expect(finalizeRunMock).toHaveBeenCalledWith(
        "run-test-1",
        "failed",
        expect.objectContaining({
          errorMessage: expect.stringContaining("agent_build_threw"),
        }),
      );
    });

    it("logs error when finalizeRun also fails after async build failure", async () => {
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      await setupDbSelectLimit([]);
      finalizeRunMock.mockRejectedValueOnce(new Error("finalize boom"));
      buildBuiltinAgentsMock.mockResolvedValue({
        agents: {},
        borrowed: [],
        degradations: new Map(),
        supervisorRunHolders: new Map(),
      });

      await expect(
        runner.start({
          mode: "async",
          entityId: "agent-1",
          ownerId: "user-1",
          task: "do work",
          initiator: "user",
          createdBy: "user-1",
        }),
      ).rejects.toThrow(/could not be resolved/);
    });

    it("releases borrows and rethrows when post-subscribe setup throws", async () => {
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      getConfigMsMock.mockReturnValue(1800000);
      await setupDbSelectLimit([{ role: "editor" }]);
      buildBuiltinAgentsMock.mockResolvedValue(
        builtinAgentResult("agent-1", { __agent: "stub" }),
      );
      // PersistingAgent constructor throws — triggers the outer catch.
      persistingAgentCtorMock.mockImplementation(
        function () {
          throw new Error("persisting agent ctor blew up");
        } as never,
      );

      await expect(
        runner.start({
          mode: "async",
          entityId: "agent-1",
          ownerId: "user-1",
          task: "do work",
          initiator: "user",
          createdBy: "user-1",
        }),
      ).rejects.toThrow("persisting agent ctor blew up");
    });

    it("warns and continues when builtin agent name lookup throws", async () => {
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      getConfigMsMock.mockReturnValue(1800000);
      buildBuiltinAgentsMock.mockResolvedValue(
        builtinAgentResult("agent-1", { __agent: "stub" }),
      );
      persistingAgentHanging();
      // First db.select (agent name lookup) throws; second (resolveAuthContext) returns role.
      const { db } = await import("@/lib/db");
      vi.mocked(db.select)
        .mockImplementationOnce(
          function () {
            throw new Error("db connection lost");
          } as never,
        )
        .mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ role: "editor" }]),
            }),
          }),
        } as never);

      const result = await runner.start({
        mode: "async",
        entityId: "agent-1",
        ownerId: "user-1",
        task: "do work",
        initiator: "user",
        createdBy: "user-1",
      });

      // Still returns running — name lookup failure is non-fatal.
      expect(result.status).toBe("running");
      expect(result.runId).toBe("run-test-1");
    });
  });
});
