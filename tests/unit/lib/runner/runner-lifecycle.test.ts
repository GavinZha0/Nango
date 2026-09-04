import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { recordRunStartMock, finalizeRunMock, recordEventMock } = vi.hoisted(() => ({
  recordRunStartMock: vi.fn(),
  finalizeRunMock: vi.fn(),
  recordEventMock: vi.fn(),
}));

vi.mock("@/lib/runner/event-store", () => ({
  recordRunStart: recordRunStartMock,
  finalizeRun: finalizeRunMock,
  recordEvent: recordEventMock,
}));

vi.mock("@/lib/observability/logger", () => ({
  childLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    trace: () => {},
  }),
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

import { runner } from "@/lib/runner";
import { ApiError } from "@/lib/http/route-handlers";
import type { childLogger } from "@/lib/observability/logger";

describe("Runner — Execution Kernel & Lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
});
