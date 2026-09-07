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
import { ApiError } from "@/lib/http/route-handlers";
import type { childLogger } from "@/lib/observability/logger";

describe("Runner — Execution Kernel & Lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Helpers for the extended coverage tests below.
  // =========================================================================
  function makeLoggerMock() {
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as ReturnType<typeof childLogger>;
  }

  function defaultPeek() {
    return {
      task: "hello",
      threadId: "thread-1",
      userMessageId: "msg-1",
      triggeringToolResults: [] as unknown[],
      pageContext: null,
    };
  }

  function defaultRunStart() {
    return { id: "run-test-1", startedAt: new Date("2026-01-01T00:00:00Z") };
  }

  async function setupChatHandler(buildAgentImpl: () => Promise<unknown>) {
    const { getChatHandler } = await import("@/lib/backends/registry.server");
    const handler = { buildAgent: vi.fn(buildAgentImpl) };
    vi.mocked(getChatHandler).mockReturnValue(handler as never);
    return handler;
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
  describe("runner.start Input Validation", () => {
    it("rejects unsupported run mode with descriptive error", async () => {
      const invalidInput = {
        mode: "parallel_streaming",
        entityId: "agent-1",
        ownerId: "user-1",
        task: "do work",
      } as unknown as Parameters<typeof runner.start>[0];

      await expect(runner.start(invalidInput)).rejects.toThrow(
        /unsupported mode "parallel_streaming"/i,
      );
    });

    it("rejects backend dispatch missing entityKind", async () => {
      const backendInput = {
        mode: "sync",
        credentialId: "123e4567-e89b-12d3-a456-426614174000",
        entityId: "backend-agent-1",
        ownerId: "user-1",
        task: "do work",
      } as unknown as Parameters<typeof runner.start>[0];

      await expect(runner.start(backendInput)).rejects.toThrow(
        /entityKind is required for backend dispatch/i,
      );
    });
  });

  describe("runChatRequest Guardrails", () => {
    it("returns 400 when credentialId is missing on backend chat request", async () => {
      const req = new Request("http://localhost:9300/api/copilotkit/agent/agent-1/run", {
        method: "POST",
      });

      const res = await runner.runChatRequest(req, {
        mode: "sync",
        initiator: "user",
        createdBy: "user-1",
        entityId: "agent-1",
        entityKind: "agent",
        ownerId: "user-1",
        task: "hello",
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/credentialId required/i);
    });

    it("returns 400 when entityKind is missing on backend chat request", async () => {
      const req = new Request("http://localhost:9300/api/copilotkit/agent/agent-1/run", {
        method: "POST",
      });

      const res = await runner.runChatRequest(req, {
        mode: "sync",
        initiator: "user",
        createdBy: "user-1",
        credentialId: "123e4567-e89b-12d3-a456-426614174000",
        entityId: "agent-1",
        ownerId: "user-1",
        task: "hello",
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/entityKind is required/i);
    });

    it("returns 503 when no chat handler is registered for the provider", async () => {
      const req = new Request("http://localhost:9300/api/copilotkit/agent/agent-1/run", {
        method: "POST",
      });

      const res = await runner.runChatRequest(req, {
        mode: "sync",
        initiator: "user",
        createdBy: "user-1",
        credentialId: "123e4567-e89b-12d3-a456-426614174000",
        entityId: "agent-1",
        entityKind: "agent",
        ownerId: "user-1",
        task: "hello",
      });

      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.error).toMatch(/no chat handler registered/i);
    });
  });

  describe("runBuiltinChatRequest Guardrails", () => {
    it("throws 404 NOT_FOUND when targeted agent is not visible to user", async () => {
      const req = new Request("http://localhost:9300/api/copilotkit/builtin/agent/secret-agent/run", {
        method: "POST",
      });

      const loggerMock = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as unknown as ReturnType<typeof childLogger>;

      await expect(
        runner.runBuiltinChatRequest(req, {
          userId: "attacker-user",
          requestId: "req-1",
          log: loggerMock,
        }),
      ).rejects.toThrow(ApiError);
    });

    it("throws 503 SERVICE_UNAVAILABLE when no built-in agents exist for user", async () => {
      const req = new Request("http://localhost:9300/api/copilotkit/builtin/info", {
        method: "GET",
      });

      const loggerMock = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as unknown as ReturnType<typeof childLogger>;

      await expect(
        runner.runBuiltinChatRequest(req, {
          userId: "user-no-agents",
          requestId: "req-2",
          log: loggerMock,
        }),
      ).rejects.toThrow(ApiError);
    });
  });

  describe("buildAgentForProgrammatic — owner role resolution", () => {
    /** Regression: programmatic dispatches (schedule / evaluator / async)
     *  previously built tester tools with isEditor/isAdmin undefined, so
     *  every write tool failed closed even for the run owner. The build
     *  must hand the dispatcher a full RBAC context resolved from the
     *  owner's DB role. */
    async function mockOwnerRole(role: string | null): Promise<void> {
      const { db } = await import("@/lib/db");
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ role }]),
          }),
        }),
      } as unknown as ReturnType<typeof db.select>);
    }

    function programmaticInput() {
      return {
        entityId: "11111111-1111-1111-1111-111111111111",
        ownerId: "user-1",
        task: "run tests",
        mode: "sync",
        initiator: "schedule",
      } as unknown as Parameters<typeof runner.start>[0];
    }

    function dispatchContext(): Record<string, unknown> {
      expect(buildBuiltinAgentsMock).toHaveBeenCalledTimes(1);
      return buildBuiltinAgentsMock.mock.calls[0][2] as Record<string, unknown>;
    }

    beforeEach(() => {
      buildBuiltinAgentsMock.mockResolvedValue({
        agents: {},
        borrowed: [],
        degradations: new Map(),
        supervisorRunHolders: new Map(),
      });
    });

    it("resolves an editor owner into isEditor=true for tool RBAC", async () => {
      await mockOwnerRole("editor");

      const build = (
        runner as unknown as {
          buildAgentForProgrammatic: (i: unknown, k: string) => Promise<unknown>;
        }
      ).buildAgentForProgrammatic.bind(runner);

      await expect(build(programmaticInput(), "agent")).rejects.toThrow(
        /could not be resolved/,
      );

      expect(dispatchContext()).toMatchObject({
        userId: "user-1",
        isAdmin: false,
        isEditor: true,
        mode: "sync",
        initiator: "schedule",
      });
    });

    it("resolves an admin owner into isAdmin=true for tool RBAC", async () => {
      await mockOwnerRole("admin");

      const build = (
        runner as unknown as {
          buildAgentForProgrammatic: (i: unknown, k: string) => Promise<unknown>;
        }
      ).buildAgentForProgrammatic.bind(runner);

      await expect(build(programmaticInput(), "agent")).rejects.toThrow(
        /could not be resolved/,
      );

      expect(dispatchContext()).toMatchObject({
        userId: "user-1",
        isAdmin: true,
        isEditor: true,
      });
    });
  });

  // runChatRequest — backend dispatch paths
  // =========================================================================
  describe("runChatRequest — backend dispatch paths", () => {
    it("returns the Response directly when handler.buildAgent returns a Response (credential/config error)", async () => {
      const errorResponse = new Response(JSON.stringify({ error: "bad config" }), { status: 400 });
      await setupChatHandler(async () => errorResponse);

      const req = new Request("http://localhost:9300/api/copilotkit/agent/agent-1/run", {
        method: "POST",
      });
      const res = await runner.runChatRequest(req, {
        mode: "sync",
        initiator: "user",
        createdBy: "user-1",
        credentialId: "cred-1",
        entityId: "agent-1",
        entityKind: "agent",
        ownerId: "user-1",
        task: "hello",
      });

      expect(res).toBe(errorResponse);
      expect(res.status).toBe(400);
      expect(recordRunStartMock).not.toHaveBeenCalled();
      expect(runWithAgentsMock).not.toHaveBeenCalled();
    });

    it("/connect path skips entity_run lifecycle and attaches PersistedAgentRunner", async () => {
      await setupChatHandler(async () => ({ __agent: "stub" }));
      const dispatched = new Response("ok", { status: 200 });
      runWithAgentsMock.mockResolvedValue(dispatched);

      const req = new Request("http://localhost:9300/api/copilotkit/agent/agent-1/connect", {
        method: "POST",
      });
      const res = await runner.runChatRequest(req, {
        mode: "sync",
        initiator: "user",
        createdBy: "user-1",
        credentialId: "cred-1",
        entityId: "agent-1",
        entityKind: "agent",
        ownerId: "user-1",
        task: "hello",
      });

      expect(res).toBe(dispatched);
      expect(recordRunStartMock).not.toHaveBeenCalled();
      expect(persistedAgentRunnerCtorMock).toHaveBeenCalledTimes(1);
      expect(runWithAgentsMock).toHaveBeenCalledTimes(1);
      const opts = runWithAgentsMock.mock.calls[0][1] as Record<string, unknown>;
      expect(opts.trimMessages).toBe(true);
      expect(opts.entitySource).toBe("backend");
    });

    it("/stop path (non-run, non-connect) skips lifecycle without PersistedAgentRunner", async () => {
      await setupChatHandler(async () => ({ __agent: "stub" }));
      const dispatched = new Response("ok", { status: 200 });
      runWithAgentsMock.mockResolvedValue(dispatched);

      const req = new Request("http://localhost:9300/api/copilotkit/agent/agent-1/stop", {
        method: "POST",
      });
      const res = await runner.runChatRequest(req, {
        mode: "sync",
        initiator: "user",
        createdBy: "user-1",
        credentialId: "cred-1",
        entityId: "agent-1",
        entityKind: "agent",
        ownerId: "user-1",
        task: "hello",
      });

      expect(res).toBe(dispatched);
      expect(recordRunStartMock).not.toHaveBeenCalled();
      expect(persistedAgentRunnerCtorMock).not.toHaveBeenCalled();
      expect(runWithAgentsMock).toHaveBeenCalledTimes(1);
    });

    it("/run path records entity_run start and dispatches with trimMessages: true", async () => {
      await setupChatHandler(async () => ({ __agent: "stub" }));
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      extractRunInputMock.mockResolvedValue(defaultPeek());
      const dispatched = new Response("ok", { status: 200 });
      runWithAgentsMock.mockResolvedValue(dispatched);

      const req = new Request("http://localhost:9300/api/copilotkit/agent/agent-1/run", {
        method: "POST",
      });
      const res = await runner.runChatRequest(req, {
        mode: "sync",
        initiator: "user",
        createdBy: "user-1",
        credentialId: "cred-1",
        entityId: "agent-1",
        entityKind: "agent",
        ownerId: "user-1",
        task: "hello",
      });

      expect(res).toBe(dispatched);
      expect(recordRunStartMock).toHaveBeenCalledTimes(1);
      expect(recordRunStartMock).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: "agent-1",
          entityKind: "agent",
          entitySource: "backend",
          credentialId: "cred-1",
          mode: "sync",
          task: "hello",
        }),
      );
      expect(runWithAgentsMock).toHaveBeenCalledTimes(1);
      const opts = runWithAgentsMock.mock.calls[0][1] as Record<string, unknown>;
      expect(opts.trimMessages).toBe(true);
      expect(opts.entitySource).toBe("backend");
      expect(persistedAgentRunnerCtorMock).toHaveBeenCalledTimes(1);
    });

    it("/run path finalizes run as failed and rethrows when runWithAgents throws", async () => {
      await setupChatHandler(async () => ({ __agent: "stub" }));
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      extractRunInputMock.mockResolvedValue(defaultPeek());
      runWithAgentsMock.mockRejectedValue(new Error("dispatch boom"));

      const req = new Request("http://localhost:9300/api/copilotkit/agent/agent-1/run", {
        method: "POST",
      });
      await expect(
        runner.runChatRequest(req, {
          mode: "sync",
          initiator: "user",
          createdBy: "user-1",
          credentialId: "cred-1",
          entityId: "agent-1",
          entityKind: "agent",
          ownerId: "user-1",
          task: "hello",
        }),
      ).rejects.toThrow("dispatch boom");

      expect(finalizeRunMock).toHaveBeenCalledWith("run-test-1", "failed", {
        errorMessage: "dispatch boom",
      });
    });

    it("/connect path rethrows without finalizeRun when runWithAgents throws", async () => {
      await setupChatHandler(async () => ({ __agent: "stub" }));
      runWithAgentsMock.mockRejectedValue(new Error("connect boom"));

      const req = new Request("http://localhost:9300/api/copilotkit/agent/agent-1/connect", {
        method: "POST",
      });
      await expect(
        runner.runChatRequest(req, {
          mode: "sync",
          initiator: "user",
          createdBy: "user-1",
          credentialId: "cred-1",
          entityId: "agent-1",
          entityKind: "agent",
          ownerId: "user-1",
          task: "hello",
        }),
      ).rejects.toThrow("connect boom");

      expect(finalizeRunMock).not.toHaveBeenCalled();
    });

    it("/run path finalizes with String(err) when non-Error is thrown", async () => {
      await setupChatHandler(async () => ({ __agent: "stub" }));
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      extractRunInputMock.mockResolvedValue(defaultPeek());
      runWithAgentsMock.mockRejectedValue("non-error string");

      const req = new Request("http://localhost:9300/api/copilotkit/agent/agent-1/run", {
        method: "POST",
      });
      await expect(
        runner.runChatRequest(req, {
          mode: "sync",
          initiator: "user",
          createdBy: "user-1",
          credentialId: "cred-1",
          entityId: "agent-1",
          entityKind: "agent",
          ownerId: "user-1",
          task: "hello",
        }),
      ).rejects.toBe("non-error string");

      expect(finalizeRunMock).toHaveBeenCalledWith("run-test-1", "failed", {
        errorMessage: "non-error string",
      });
    });

    it("/run path skips user message event when task is empty", async () => {
      await setupChatHandler(async () => ({ __agent: "stub" }));
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      extractRunInputMock.mockResolvedValue({
        task: "",
        threadId: "thread-1",
        userMessageId: undefined,
        triggeringToolResults: [],
        pageContext: null,
      });
      runWithAgentsMock.mockResolvedValue(new Response("ok", { status: 200 }));

      const req = new Request("http://localhost:9300/api/copilotkit/agent/agent-1/run", {
        method: "POST",
      });
      const res = await runner.runChatRequest(req, {
        mode: "sync",
        initiator: "user",
        createdBy: "user-1",
        credentialId: "cred-1",
        entityId: "agent-1",
        entityKind: "agent",
        ownerId: "user-1",
        task: "",
      });

      expect(res.status).toBe(200);
      // No "message" event written because task is empty.
      const messageCalls = recordEventMock.mock.calls.filter((c) => c[2] === "message");
      expect(messageCalls).toHaveLength(0);
    });
  });

  // =========================================================================
  // runBuiltinChatRequest — builtin dispatch paths
  // =========================================================================
  describe("runBuiltinChatRequest — builtin dispatch paths", () => {
    it("bookkeeping path dispatches with trimMessages: false and no recordRunStart", async () => {
      const { listVisibleAgentIds } = await import("@/lib/access/agent-visibility");
      vi.mocked(listVisibleAgentIds).mockResolvedValue(["agent-1", "agent-2"]);
      const dispatched = new Response("ok", { status: 200 });
      runWithAgentsMock.mockResolvedValue(dispatched);

      const req = new Request("http://localhost:9300/api/copilotkit/builtin/info", {
        method: "GET",
      });
      const res = await runner.runBuiltinChatRequest(req, {
        userId: "user-1",
        requestId: "req-1",
        log: makeLoggerMock(),
      });

      expect(res).toBe(dispatched);
      expect(recordRunStartMock).not.toHaveBeenCalled();
      expect(builtInAgentCtorMock).toHaveBeenCalledTimes(2);
      expect(runWithAgentsMock).toHaveBeenCalledTimes(1);
      const opts = runWithAgentsMock.mock.calls[0][1] as Record<string, unknown>;
      expect(opts.trimMessages).toBe(false);
      expect(opts.entitySource).toBe("builtin");
      expect(opts.endpoint).toBe("/api/copilotkit/builtin");
    });

    it("bookkeeping path rethrows when runWithAgents throws", async () => {
      const { listVisibleAgentIds } = await import("@/lib/access/agent-visibility");
      vi.mocked(listVisibleAgentIds).mockResolvedValue(["agent-1"]);
      runWithAgentsMock.mockRejectedValue(new Error("bookkeeping boom"));

      const req = new Request("http://localhost:9300/api/copilotkit/builtin/info", {
        method: "GET",
      });
      await expect(
        runner.runBuiltinChatRequest(req, {
          userId: "user-1",
          requestId: "req-1",
          log: makeLoggerMock(),
        }),
      ).rejects.toThrow("bookkeeping boom");
    });

    it("run path records run start, builds agents, and dispatches with trimMessages: false", async () => {
      const { isAgentVisibleTo } = await import("@/lib/access/agent-visibility");
      vi.mocked(isAgentVisibleTo).mockResolvedValue(true);
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      extractRunInputMock.mockResolvedValue(defaultPeek());
      const stubAgent = { __agent: "builtin-stub" };
      buildBuiltinAgentsMock.mockResolvedValue(builtinAgentResult("agent-1", stubAgent));
      const dispatched = new Response("ok", { status: 200 });
      runWithAgentsMock.mockResolvedValue(dispatched);

      const req = new Request("http://localhost:9300/api/copilotkit/builtin/agent/agent-1/run", {
        method: "POST",
      });
      const res = await runner.runBuiltinChatRequest(req, {
        userId: "user-1",
        requestId: "req-1",
        log: makeLoggerMock(),
      });

      expect(res).toBe(dispatched);
      expect(recordRunStartMock).toHaveBeenCalledTimes(1);
      expect(recordRunStartMock).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: "agent-1",
          entityKind: "agent",
          entitySource: "builtin",
          mode: "sync",
        }),
      );
      expect(buildBuiltinAgentsMock).toHaveBeenCalledTimes(1);
      expect(runWithAgentsMock).toHaveBeenCalledTimes(1);
      const opts = runWithAgentsMock.mock.calls[0][1] as Record<string, unknown>;
      expect(opts.trimMessages).toBe(false);
      expect(opts.entitySource).toBe("builtin");
      expect((opts.agents as Record<string, unknown>)["agent-1"]).toBe(stubAgent);
    });

    it("run path finalizes run as failed and rethrows when buildBuiltinAgents throws", async () => {
      const { isAgentVisibleTo } = await import("@/lib/access/agent-visibility");
      vi.mocked(isAgentVisibleTo).mockResolvedValue(true);
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      extractRunInputMock.mockResolvedValue(defaultPeek());
      buildBuiltinAgentsMock.mockRejectedValue(new Error("mcp discovery failed"));

      const req = new Request("http://localhost:9300/api/copilotkit/builtin/agent/agent-1/run", {
        method: "POST",
      });
      await expect(
        runner.runBuiltinChatRequest(req, {
          userId: "user-1",
          requestId: "req-1",
          log: makeLoggerMock(),
        }),
      ).rejects.toThrow("mcp discovery failed");

      expect(finalizeRunMock).toHaveBeenCalledWith(
        "run-test-1",
        "failed",
        expect.objectContaining({
          errorMessage: expect.stringContaining("agent_build_threw"),
        }),
      );
    });

    it("run path throws 503 when all visible agents have unresolvable specs", async () => {
      const { isAgentVisibleTo } = await import("@/lib/access/agent-visibility");
      vi.mocked(isAgentVisibleTo).mockResolvedValue(true);
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      extractRunInputMock.mockResolvedValue(defaultPeek());
      buildBuiltinAgentsMock.mockResolvedValue({
        agents: {},
        borrowed: [],
        degradations: new Map(),
        supervisorRunHolders: new Map(),
      });

      const req = new Request("http://localhost:9300/api/copilotkit/builtin/agent/agent-1/run", {
        method: "POST",
      });
      await expect(
        runner.runBuiltinChatRequest(req, {
          userId: "user-1",
          requestId: "req-1",
          log: makeLoggerMock(),
        }),
      ).rejects.toThrow(ApiError);

      expect(finalizeRunMock).toHaveBeenCalledWith(
        "run-test-1",
        "failed",
        expect.objectContaining({ errorMessage: "specs_all_null" }),
      );
    });

    it("run path throws 503 when target agent missing from built agents map", async () => {
      const { isAgentVisibleTo } = await import("@/lib/access/agent-visibility");
      vi.mocked(isAgentVisibleTo).mockResolvedValue(true);
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      extractRunInputMock.mockResolvedValue(defaultPeek());
      buildBuiltinAgentsMock.mockResolvedValue({
        agents: { "other-agent": { __agent: "stub" } },
        borrowed: [],
        degradations: new Map([
          [
            "agent-1",
            [
              {
                ref: "agent-1",
                refName: null,
                reason: "spec_skip",
                message: "Agent spec unavailable",
              },
            ],
          ],
        ]),
        supervisorRunHolders: new Map(),
      });

      const req = new Request("http://localhost:9300/api/copilotkit/builtin/agent/agent-1/run", {
        method: "POST",
      });
      await expect(
        runner.runBuiltinChatRequest(req, {
          userId: "user-1",
          requestId: "req-1",
          log: makeLoggerMock(),
        }),
      ).rejects.toThrow(ApiError);

      expect(finalizeRunMock).toHaveBeenCalledWith(
        "run-test-1",
        "failed",
        expect.objectContaining({
          errorMessage: expect.stringContaining("agent_build_failed"),
        }),
      );
    });

    it("/connect path for builtin attaches PersistedAgentRunner without recording run start", async () => {
      const { isAgentVisibleTo } = await import("@/lib/access/agent-visibility");
      vi.mocked(isAgentVisibleTo).mockResolvedValue(true);
      buildBuiltinAgentsMock.mockResolvedValue(
        builtinAgentResult("agent-1", { __agent: "stub" }),
      );
      const dispatched = new Response("ok", { status: 200 });
      runWithAgentsMock.mockResolvedValue(dispatched);

      const req = new Request(
        "http://localhost:9300/api/copilotkit/builtin/agent/agent-1/connect",
        { method: "POST" },
      );
      const res = await runner.runBuiltinChatRequest(req, {
        userId: "user-1",
        requestId: "req-1",
        log: makeLoggerMock(),
      });

      expect(res).toBe(dispatched);
      expect(recordRunStartMock).not.toHaveBeenCalled();
      expect(persistedAgentRunnerCtorMock).toHaveBeenCalledTimes(1);
      expect(runWithAgentsMock).toHaveBeenCalledTimes(1);
    });

    it("run path records tool_call_result events for continuation (triggeringToolResults)", async () => {
      const { isAgentVisibleTo } = await import("@/lib/access/agent-visibility");
      vi.mocked(isAgentVisibleTo).mockResolvedValue(true);
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      extractRunInputMock.mockResolvedValue({
        task: "Go",
        threadId: "thread-1",
        userMessageId: undefined,
        triggeringToolResults: [
          { toolCallId: "call_1", content: "Go" },
          { toolCallId: "call_2", content: "Yes" },
        ],
        pageContext: null,
      });
      buildBuiltinAgentsMock.mockResolvedValue(
        builtinAgentResult("agent-1", { __agent: "stub" }),
      );
      runWithAgentsMock.mockResolvedValue(new Response("ok", { status: 200 }));

      const req = new Request("http://localhost:9300/api/copilotkit/builtin/agent/agent-1/run", {
        method: "POST",
      });
      await runner.runBuiltinChatRequest(req, {
        userId: "user-1",
        requestId: "req-1",
        log: makeLoggerMock(),
      });

      // Two tool_call_result events at seq 0 and 1, no user message event.
      const toolResultCalls = recordEventMock.mock.calls.filter(
        (c) => c[2] === "tool_call_result",
      );
      expect(toolResultCalls).toHaveLength(2);
      expect(toolResultCalls[0][1]).toBe(0);
      expect(toolResultCalls[1][1]).toBe(1);
    });

    it("/stop path for builtin attaches PersistedAgentRunner without recording run start", async () => {
      const { isAgentVisibleTo } = await import("@/lib/access/agent-visibility");
      vi.mocked(isAgentVisibleTo).mockResolvedValue(true);
      buildBuiltinAgentsMock.mockResolvedValue(
        builtinAgentResult("agent-1", { __agent: "stub" }),
      );
      const dispatched = new Response("ok", { status: 200 });
      runWithAgentsMock.mockResolvedValue(dispatched);

      const req = new Request(
        "http://localhost:9300/api/copilotkit/builtin/agent/agent-1/stop",
        { method: "POST" },
      );
      const res = await runner.runBuiltinChatRequest(req, {
        userId: "user-1",
        requestId: "req-1",
        log: makeLoggerMock(),
      });

      expect(res).toBe(dispatched);
      expect(recordRunStartMock).not.toHaveBeenCalled();
      expect(persistedAgentRunnerCtorMock).toHaveBeenCalledTimes(1);
    });

    it("run path wires supervisor holder when present for target agent", async () => {
      const { isAgentVisibleTo } = await import("@/lib/access/agent-visibility");
      vi.mocked(isAgentVisibleTo).mockResolvedValue(true);
      recordRunStartMock.mockResolvedValue(defaultRunStart());
      extractRunInputMock.mockResolvedValue(defaultPeek());
      const holder = { current: undefined, threadId: undefined };
      buildBuiltinAgentsMock.mockResolvedValue({
        agents: { "agent-1": { __agent: "stub" } },
        borrowed: [],
        degradations: new Map(),
        supervisorRunHolders: new Map([["agent-1", holder]]),
      });
      runWithAgentsMock.mockResolvedValue(new Response("ok", { status: 200 }));

      const req = new Request("http://localhost:9300/api/copilotkit/builtin/agent/agent-1/run", {
        method: "POST",
      });
      await runner.runBuiltinChatRequest(req, {
        userId: "user-1",
        requestId: "req-1",
        log: makeLoggerMock(),
      });

      expect(holder.current).toBe("run-test-1");
      expect(holder.threadId).toBe("thread-1");
    });
  });

});
