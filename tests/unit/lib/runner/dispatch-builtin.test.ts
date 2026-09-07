import { describe, it, expect, vi, beforeEach } from "vitest";


// ---------------------------------------------------------------------------
// Hoisted mock handles — every module imported by dispatch/builtin.ts is
// mocked so buildBuiltinAgents can be exercised in isolation.
// ---------------------------------------------------------------------------

const {
  recordEventMock,
  mcpReleaseMock,
  mcpBorrowMock,
  mcpEvictMock,
  resolveLanguageModelMock,
  agentPoolGetMock,
  skillPoolGetManyMock,
  buildSkillsRuntimeMock,
  buildBuiltinToolsMock,
  buildDataSourcesPromptBlockMock,
  buildExtractDatasetToolMock,
  buildGetCurrentDatetimeToolMock,
  buildCalendarPromptBlockMock,
  buildFetchCalendarEventsToolMock,
  buildChartPromptBlockMock,
  buildHtmlPagePromptBlockMock,
  buildSshHostsPromptBlockMock,
  buildRunSshCommandToolMock,
  buildListSshHostsToolMock,
  buildSupervisorRuntimeMock,
  composeToolPipelineMock,
  composePipelinedMcpProviderMock,
  buildServerToolMiddlewaresMock,
  resolveOrchestrationModeMock,
  buildSubmitEvaluationScoresToolMock,
  buildTesterToolsMock,
  BuiltInAgentCtorMock,
} = vi.hoisted(() => ({
  recordEventMock: vi.fn().mockResolvedValue(undefined),
  mcpReleaseMock: vi.fn(),
  mcpBorrowMock: vi.fn(),
  mcpEvictMock: vi.fn().mockResolvedValue(undefined),
  resolveLanguageModelMock: vi.fn(),
  agentPoolGetMock: vi.fn(),
  skillPoolGetManyMock: vi.fn().mockResolvedValue([]),
  buildSkillsRuntimeMock: vi.fn().mockReturnValue({ tools: [], promptBlock: "" }),
  buildBuiltinToolsMock: vi.fn().mockReturnValue([]),
  buildDataSourcesPromptBlockMock: vi.fn().mockResolvedValue({ promptBlock: "" }),
  buildExtractDatasetToolMock: vi.fn().mockReturnValue({ name: "extract_dataset_by_sql" }),
  buildGetCurrentDatetimeToolMock: vi.fn().mockReturnValue({ name: "get_current_datetime" }),
  buildCalendarPromptBlockMock: vi.fn().mockResolvedValue({ promptBlock: "" }),
  buildFetchCalendarEventsToolMock: vi.fn().mockReturnValue({ name: "fetch_calendar_events" }),
  buildChartPromptBlockMock: vi.fn().mockReturnValue("CHART_PROMPT"),
  buildHtmlPagePromptBlockMock: vi.fn().mockReturnValue("HTML_PAGE_PROMPT"),
  buildSshHostsPromptBlockMock: vi.fn().mockResolvedValue({ promptBlock: "" }),
  buildRunSshCommandToolMock: vi.fn().mockReturnValue({ name: "run_ssh_command" }),
  buildListSshHostsToolMock: vi.fn().mockReturnValue({ name: "list_ssh_hosts" }),
  buildSupervisorRuntimeMock: vi.fn(),
  composeToolPipelineMock: vi.fn().mockReturnValue((t: unknown) => t),
  composePipelinedMcpProviderMock: vi.fn().mockImplementation((p: unknown) => p),
  buildServerToolMiddlewaresMock: vi.fn().mockReturnValue([]),
  resolveOrchestrationModeMock: vi.fn().mockReturnValue({ promptDirective: "MODE_DIRECTIVE" }),
  buildSubmitEvaluationScoresToolMock: vi.fn().mockReturnValue({ name: "submit_evaluation_scores" }),
  buildTesterToolsMock: vi.fn().mockReturnValue([{ name: "run_test_case" }]),
  BuiltInAgentCtorMock: vi.fn(),
}));

vi.mock("@/lib/runner/event-store", () => ({
  recordEvent: recordEventMock,
}));

vi.mock("@/lib/mcp", () => ({
  mcpProviderPool: {
    release: mcpReleaseMock,
    borrow: mcpBorrowMock,
    evictWithCooldown: mcpEvictMock,
  },
}));

vi.mock("@/lib/builtin-agents/model-resolver", () => ({
  resolveLanguageModel: resolveLanguageModelMock,
}));

vi.mock("@/lib/builtin-agents", () => ({
  agentPool: {
    get: agentPoolGetMock,
  },
}));

vi.mock("@/lib/copilot/index.server", () => ({
  BuiltInAgent: BuiltInAgentCtorMock,
}));

vi.mock("@/lib/builtin-tools", () => ({
  buildBuiltinTools: buildBuiltinToolsMock,
}));

vi.mock("@/lib/skills", () => ({
  skillPool: {
    getMany: skillPoolGetManyMock,
  },
}));

vi.mock("@/lib/skills/runtime-tools", () => ({
  buildSkillsRuntime: buildSkillsRuntimeMock,
}));

vi.mock("@/lib/data-sources/prompt-block.server", () => ({
  buildDataSourcesPromptBlock: buildDataSourcesPromptBlockMock,
}));

vi.mock("@/lib/data-sources/runtime-tools", () => ({
  buildExtractDatasetTool: buildExtractDatasetToolMock,
}));

vi.mock("@/lib/time/runtime-tools", () => ({
  buildGetCurrentDatetimeTool: buildGetCurrentDatetimeToolMock,
}));

vi.mock("@/lib/calendar/prompt-block.server", () => ({
  buildCalendarPromptBlock: buildCalendarPromptBlockMock,
}));

vi.mock("@/lib/calendar/runtime-tools", () => ({
  buildFetchCalendarEventsTool: buildFetchCalendarEventsToolMock,
}));

vi.mock("@/lib/outcomes/prompt-block.server", () => ({
  buildChartPromptBlock: buildChartPromptBlockMock,
  buildHtmlPagePromptBlock: buildHtmlPagePromptBlockMock,
}));

vi.mock("@/lib/ssh/prompt-block.server", () => ({
  buildSshHostsPromptBlock: buildSshHostsPromptBlockMock,
}));

vi.mock("@/lib/ssh/runtime-tools", () => ({
  buildRunSshCommandTool: buildRunSshCommandToolMock,
  buildListSshHostsTool: buildListSshHostsToolMock,
}));

vi.mock("@/lib/runner/supervisor-tools.server", () => ({
  buildSupervisorRuntime: buildSupervisorRuntimeMock,
}));

vi.mock("@/lib/agent-pipeline/compose", () => ({
  composeToolPipeline: composeToolPipelineMock,
  composePipelinedMcpProvider: composePipelinedMcpProviderMock,
}));

vi.mock("@/lib/agent-pipeline/middlewares", () => ({
  buildServerToolMiddlewares: buildServerToolMiddlewaresMock,
}));

vi.mock("@/lib/orchestration/modes", () => ({
  resolveOrchestrationMode: resolveOrchestrationModeMock,
}));

vi.mock("@/lib/evaluation/runtime-tools", () => ({
  buildSubmitEvaluationScoresTool: buildSubmitEvaluationScoresToolMock,
}));

vi.mock("@/lib/testing/tester-tools.server", () => ({
  buildTesterTools: buildTesterToolsMock,
}));

import {
  buildBuiltinAgents,
  classifyBuiltinPath,
  releaseBuiltinBorrows,
  recordCapabilityDegradations,
  type BorrowRecord,
  type CapabilityDegradation,
} from "@/lib/runner/dispatch/builtin";
import type { AgentSpec } from "@/lib/builtin-agents/agent-spec";
import type { childLogger } from "@/lib/observability/logger";
import type { GracefulMcpProvider } from "@/lib/mcp/client-providers";
import {
  SAFETY_POLICY_BLOCK,
  AUTO_APPROVAL_POLICY_BLOCK,
  ALWAYS_APPROVAL_POLICY_BLOCK,
} from "@/lib/constants/safety";
import { SHARED_STATE_PROMPT_BLOCK } from "@/lib/constants/supervisor";

const mockLogger = {
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
} as unknown as ReturnType<typeof childLogger>;

/** Build a valid AgentSpec with sensible defaults; override per-test. */
function makeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    agentId: "agent-1",
    name: "Test Agent",
    role: null,
    modelProvider: "openai",
    model: "gpt-4o",
    prompt: null,
    temperature: null,
    maxTokens: null,
    toolApprovalMode: "never",
    sharedStateEnabled: false,
    maxSteps: 5,
    apiKey: "sk-test",
    restUrl: null,
    tools: [],
    ...overrides,
  };
}

/** Capture the args passed to the BuiltInAgent constructor for the nth call. */
function agentArgs(callIndex = 0): Record<string, unknown> {
  return BuiltInAgentCtorMock.mock.calls[callIndex][0] as Record<string, unknown>;
}

/** A ready MCP provider stub. */
function readyProvider(label = "MCP"): GracefulMcpProvider {
  return {
    health: "ready",
    label,
    tools: vi.fn().mockResolvedValue([]),
    lastErrorMessage: null,
  } as unknown as GracefulMcpProvider;
}

describe("Runner Dispatch — Builtin Agents Dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("classifyBuiltinPath", () => {
    it("correctly extracts agentId and action for run/connect/stop endpoints", () => {
      expect(classifyBuiltinPath("/api/copilotkit/builtin/agent/agent-abc-123/run")).toEqual({
        agentId: "agent-abc-123",
        action: "run",
      });

      expect(classifyBuiltinPath("/api/copilotkit/builtin/agent/agent-xyz/connect")).toEqual({
        agentId: "agent-xyz",
        action: "connect",
      });

      expect(classifyBuiltinPath("/api/copilotkit/builtin/agent/agent-999/stop")).toEqual({
        agentId: "agent-999",
        action: "stop",
      });
    });

    it("returns null for non-agent bookkeeping endpoints", () => {
      expect(classifyBuiltinPath("/api/copilotkit/builtin/info")).toBeNull();
      expect(classifyBuiltinPath("/api/copilotkit/builtin")).toBeNull();
      expect(classifyBuiltinPath("/api/copilotkit/builtin/threads/t-1")).toBeNull();
    });

    it("extracts agentId containing hyphens and digits for run action", () => {
      expect(classifyBuiltinPath("/agent/0190f1c0-7b80-7000-8000-000000000001/run")).toEqual({
        agentId: "0190f1c0-7b80-7000-8000-000000000001",
        action: "run",
      });
    });
  });

  describe("releaseBuiltinBorrows", () => {
    it("safely releases all borrowed MCP providers in ledger", () => {
      const mockProviderA = { serverId: "mcp-server-1" } as unknown as GracefulMcpProvider;
      const mockProviderB = { serverId: "mcp-server-2" } as unknown as GracefulMcpProvider;

      const borrows: BorrowRecord[] = [
        { serverId: "mcp-server-1", provider: mockProviderA },
        { serverId: "mcp-server-2", provider: mockProviderB },
      ];

      releaseBuiltinBorrows(borrows);

      expect(mcpReleaseMock).toHaveBeenCalledTimes(2);
      expect(mcpReleaseMock).toHaveBeenNthCalledWith(1, "mcp-server-1", mockProviderA);
      expect(mcpReleaseMock).toHaveBeenNthCalledWith(2, "mcp-server-2", mockProviderB);
    });


    it("releases the same serverId twice when ledger contains duplicate borrows", () => {
      const provider = { id: 1 } as unknown as GracefulMcpProvider;
      const borrows: BorrowRecord[] = [
        { serverId: "mcp-1", provider },
        { serverId: "mcp-1", provider },
      ];
      releaseBuiltinBorrows(borrows);
      expect(mcpReleaseMock).toHaveBeenCalledTimes(2);
      expect(mcpReleaseMock).toHaveBeenNthCalledWith(1, "mcp-1", provider);
      expect(mcpReleaseMock).toHaveBeenNthCalledWith(2, "mcp-1", provider);
    });
  });

  describe("recordCapabilityDegradations", () => {
    it("persists each degradation as a degraded event starting from given sequence number", async () => {
      const degradations: CapabilityDegradation[] = [
        {
          ref: "mcp-1",
          refName: "Fetch MCP",
          reason: "mcp_borrow_failed",
          message: "Connection timeout",
        },
        {
          ref: "skill-2",
          refName: "Python Exec",
          reason: "skill_parse_failed",
          message: "Invalid syntax",
        },
      ];

      const nextSeq = await recordCapabilityDegradations("run-xyz", degradations, mockLogger, 5);

      expect(nextSeq).toBe(7);
      expect(recordEventMock).toHaveBeenCalledTimes(2);
      expect(recordEventMock).toHaveBeenNthCalledWith(1, "run-xyz", 5, "degraded", degradations[0]);
      expect(recordEventMock).toHaveBeenNthCalledWith(2, "run-xyz", 6, "degraded", degradations[1]);
    });

    it("returns startSeq directly when degradations list is empty", async () => {
      const nextSeq = await recordCapabilityDegradations("run-xyz", [], mockLogger, 3);
      expect(nextSeq).toBe(3);
      expect(recordEventMock).not.toHaveBeenCalled();
    });

    it("logs degraded_write_failed and continues when recordEvent throws for one row", async () => {
      recordEventMock.mockReset();
      recordEventMock.mockRejectedValueOnce(new Error("db write failed"));
      recordEventMock.mockResolvedValue(undefined);

      const degradations: CapabilityDegradation[] = [
        { ref: "mcp-1", refName: "M", reason: "mcp_borrow_failed", message: "x" },
        { ref: "mcp-2", refName: "N", reason: "mcp_borrow_failed", message: "y" },
      ];

      const nextSeq = await recordCapabilityDegradations("run-1", degradations, mockLogger, 10);

      // Both rows attempted; seq advances by list.length regardless of failures.
      expect(nextSeq).toBe(12);
      expect(recordEventMock).toHaveBeenCalledTimes(2);
      expect(recordEventMock).toHaveBeenNthCalledWith(1, "run-1", 10, "degraded", degradations[0]);
      expect(recordEventMock).toHaveBeenNthCalledWith(2, "run-1", 11, "degraded", degradations[1]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "degraded_write_failed",
          runId: "run-1",
          seq: 10,
          err: { message: "db write failed", name: "Error" },
        }),
        "failed to persist degraded event; continuing",
      );
    });

    it("serializes non-Error throw value as String(err) in degraded_write_failed log", async () => {
      recordEventMock.mockReset();
      recordEventMock.mockRejectedValueOnce("string error");
      recordEventMock.mockResolvedValue(undefined);

      const degradations: CapabilityDegradation[] = [
        { ref: "mcp-1", refName: null, reason: "mcp_borrow_failed", message: "boom" },
      ];

      const nextSeq = await recordCapabilityDegradations("run-2", degradations, mockLogger, 0);

      expect(nextSeq).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "degraded_write_failed",
          err: "string error",
        }),
        "failed to persist degraded event; continuing",
      );
    });
  });

  // =========================================================================
  // buildBuiltinAgents — the main dispatch builder.
  // =========================================================================
  describe("buildBuiltinAgents", () => {
    // Per-test default mock state. Parent beforeEach already ran clearAllMocks.
    beforeEach(() => {
      agentPoolGetMock.mockResolvedValue(null);
      resolveLanguageModelMock.mockReturnValue({ model: "openai:gpt-4o" });
      skillPoolGetManyMock.mockResolvedValue([]);
      buildSkillsRuntimeMock.mockReturnValue({ tools: [], promptBlock: "" });
      buildBuiltinToolsMock.mockReturnValue([]);
      buildDataSourcesPromptBlockMock.mockResolvedValue({ promptBlock: "" });
      buildSshHostsPromptBlockMock.mockResolvedValue({ promptBlock: "" });
      buildCalendarPromptBlockMock.mockResolvedValue({ promptBlock: "" });
      buildGetCurrentDatetimeToolMock.mockReturnValue({ name: "get_current_datetime" });
      buildExtractDatasetToolMock.mockReturnValue({ name: "extract_dataset_by_sql" });
      buildFetchCalendarEventsToolMock.mockReturnValue({ name: "fetch_calendar_events" });
      buildRunSshCommandToolMock.mockReturnValue({ name: "run_ssh_command" });
      buildListSshHostsToolMock.mockReturnValue({ name: "list_ssh_hosts" });
      buildChartPromptBlockMock.mockReturnValue("CHART_PROMPT");
      buildHtmlPagePromptBlockMock.mockReturnValue("HTML_PAGE_PROMPT");
      mcpBorrowMock.mockResolvedValue(readyProvider());
      mcpEvictMock.mockResolvedValue(undefined);
      buildSupervisorRuntimeMock.mockResolvedValue({ tools: [], catalogPromptBlock: "" });
      composeToolPipelineMock.mockReturnValue((t: unknown) => t);
      composePipelinedMcpProviderMock.mockImplementation((p: unknown) => p);
      buildServerToolMiddlewaresMock.mockReturnValue([]);
      resolveOrchestrationModeMock.mockReturnValue({ promptDirective: "MODE_DIRECTIVE" });
      buildSubmitEvaluationScoresToolMock.mockReturnValue({ name: "submit_evaluation_scores" });
      buildTesterToolsMock.mockReturnValue([{ name: "run_test_case" }]);
    });

    describe("empty / spec-skip paths", () => {
      it("returns empty map when agentIds is empty", async () => {
        const result = await buildBuiltinAgents([], mockLogger);
        expect(result.agents).toEqual({});
        expect(result.borrowed).toEqual([]);
        expect(result.degradations.size).toBe(0);
        expect(result.supervisorRunHolders.size).toBe(0);
        expect(BuiltInAgentCtorMock).not.toHaveBeenCalled();
      });

      it("records spec_skip degradation and skips agent when agentPool.get returns null", async () => {
        agentPoolGetMock.mockResolvedValue(null);

        const result = await buildBuiltinAgents(["agent-x"], mockLogger);

        expect(result.agents).toEqual({});
        expect(result.degradations.get("agent-x")).toEqual([
          {
            ref: "agent-x",
            refName: null,
            reason: "spec_skip",
            message: "Agent spec unavailable (disabled, deleted, or invalid).",
          },
        ]);
        expect(mockLogger.warn).toHaveBeenCalledWith(
          { event: "spec_skip", agentId: "agent-x" },
          "spec unavailable; skipping",
        );
        expect(BuiltInAgentCtorMock).not.toHaveBeenCalled();
      });
    });

    describe("basic agent construction", () => {
      it("builds a single agent with ambient tools and safety policy when spec has no bindings", async () => {
        const spec = makeSpec({ agentId: "agent-1", prompt: "You are helpful." });
        agentPoolGetMock.mockResolvedValue(spec);

        const result = await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(Object.keys(result.agents)).toEqual(["agent-1"]);
        expect(BuiltInAgentCtorMock).toHaveBeenCalledTimes(1);
        const args = agentArgs();
        expect(args.model).toBe("openai:gpt-4o");
        expect(args.toolChoice).toBe("auto");
        // hasTools true (ambient) → max(spec.maxSteps, 2)
        expect(args.maxSteps).toBe(5);
        expect(args.prompt).toEqual(expect.stringContaining("You are helpful."));
        expect(args.prompt).toEqual(expect.stringContaining(SAFETY_POLICY_BLOCK));
        // ambient get_current_datetime only
        expect((args.tools as unknown[]).length).toBe(1);
        expect(result.degradations.size).toBe(0);
        expect(result.borrowed).toEqual([]);
      });

      it("passes apiKey to BuiltInAgent when resolveLanguageModel returns a string model with apiKey", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec());
        resolveLanguageModelMock.mockReturnValue({ model: "openai:gpt-4o", apiKey: "sk-real" });

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(agentArgs().apiKey).toBe("sk-real");
      });

      it("omits apiKey when resolveLanguageModel returns a non-string model instance", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec());
        resolveLanguageModelMock.mockReturnValue({ model: { id: "ollama:llama3" } });

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(agentArgs().apiKey).toBeUndefined();
        expect(agentArgs().model).toEqual({ id: "ollama:llama3" });
      });

      it("passes temperature and maxTokens when spec defines non-null values", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec({ temperature: 0.3, maxTokens: 1000 }));

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(agentArgs().temperature).toBe(0.3);
        expect(agentArgs().maxTokens).toBe(1000);
      });

      it("omits temperature and maxTokens when spec values are null", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec({ temperature: null, maxTokens: null }));

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(agentArgs().temperature).toBeUndefined();
        expect(agentArgs().maxTokens).toBeUndefined();
      });

      it("clamps maxSteps to at least 2 when tools are bound", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec({ maxSteps: 1 }));

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(agentArgs().maxSteps).toBe(2);
      });

      it("builds multiple agents preserving order in the returned map", async () => {
        const spec1 = makeSpec({ agentId: "agent-1", name: "A" });
        const spec2 = makeSpec({ agentId: "agent-2", name: "B", prompt: "Second." });
        agentPoolGetMock.mockResolvedValueOnce(spec1).mockResolvedValueOnce(spec2);

        const result = await buildBuiltinAgents(["agent-1", "agent-2"], mockLogger, { userId: "user-1" });

        expect(Object.keys(result.agents)).toEqual(["agent-1", "agent-2"]);
        expect(BuiltInAgentCtorMock).toHaveBeenCalledTimes(2);
      });
    });

    describe("MCP server tool binding", () => {
      it("borrows MCP provider, awaits tools(), and sets mcpClients when health is ready", async () => {
        const provider = readyProvider("MCP One");
        mcpBorrowMock.mockResolvedValue(provider);
        agentPoolGetMock.mockResolvedValue(
          makeSpec({ tools: [{ kind: "mcp_server", mcpServerId: "mcp-1" }] }),
        );

        const result = await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(mcpBorrowMock).toHaveBeenCalledWith("mcp-1");
        expect((provider as unknown as { tools: ReturnType<typeof vi.fn> }).tools).toHaveBeenCalled();
        expect(result.borrowed).toEqual([{ serverId: "mcp-1", provider }]);
        expect(agentArgs().mcpClients).toHaveLength(1);
        expect(result.degradations.size).toBe(0);
      });

      it("records mcp_discovery_timed_out and evicts with cooldown when health is discovery-timed-out", async () => {
        const provider = {
          health: "discovery-timed-out",
          label: "MCP One",
          tools: vi.fn().mockResolvedValue([]),
          lastErrorMessage: "timed out",
        } as unknown as GracefulMcpProvider;
        mcpBorrowMock.mockResolvedValue(provider);
        agentPoolGetMock.mockResolvedValue(
          makeSpec({ tools: [{ kind: "mcp_server", mcpServerId: "mcp-1" }] }),
        );

        const result = await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(result.degradations.get("agent-1")).toEqual([
          {
            ref: "mcp-1",
            refName: "MCP One",
            reason: "mcp_discovery_timed_out",
            message: "timed out",
          },
        ]);
        expect(mcpEvictMock).toHaveBeenCalledWith("mcp-1");
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "mcp_discovery_timed_out",
            agentId: "agent-1",
            mcpServerId: "mcp-1",
            providerHealth: "discovery-timed-out",
          }),
          "MCP discovery did not succeed; agent will run without these tools",
        );
      });

      it("records mcp_discovery_failed with fallback message when health is not ready and lastErrorMessage is null", async () => {
        const provider = {
          health: "discovery-failed",
          label: "MCP Two",
          tools: vi.fn().mockResolvedValue([]),
          lastErrorMessage: null,
        } as unknown as GracefulMcpProvider;
        mcpBorrowMock.mockResolvedValue(provider);
        agentPoolGetMock.mockResolvedValue(
          makeSpec({ tools: [{ kind: "mcp_server", mcpServerId: "mcp-2" }] }),
        );

        const result = await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(result.degradations.get("agent-1")).toEqual([
          {
            ref: "mcp-2",
            refName: "MCP Two",
            reason: "mcp_discovery_failed",
            message: "MCP provider state: discovery-failed",
          },
        ]);
        expect(mcpEvictMock).toHaveBeenCalledWith("mcp-2");
      });

      it("records mcp_borrow_failed and skips provider when borrow throws", async () => {
        mcpBorrowMock.mockRejectedValue(new Error("connection refused"));
        agentPoolGetMock.mockResolvedValue(
          makeSpec({ tools: [{ kind: "mcp_server", mcpServerId: "mcp-1" }] }),
        );

        const result = await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(result.degradations.get("agent-1")).toEqual([
          {
            ref: "mcp-1",
            refName: null,
            reason: "mcp_borrow_failed",
            message: "connection refused",
          },
        ]);
        expect(result.borrowed).toHaveLength(0);
        expect(agentArgs().mcpClients).toBeUndefined();
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "mcp_borrow_failed",
            mcpServerId: "mcp-1",
            err: { message: "connection refused", name: "Error" },
          }),
          "mcp borrow failed; agent will run without it",
        );
      });

      it("serializes non-Error borrow rejection as String(err) in degradation message", async () => {
        mcpBorrowMock.mockRejectedValue("string boom");
        agentPoolGetMock.mockResolvedValue(
          makeSpec({ tools: [{ kind: "mcp_server", mcpServerId: "mcp-9" }] }),
        );

        const result = await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(result.degradations.get("agent-1")![0].message).toBe("string boom");
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "mcp_borrow_failed",
            err: "string boom",
          }),
          "mcp borrow failed; agent will run without it",
        );
      });

      it("logs mcp_evict_failed when evictWithCooldown rejects after a discovery failure", async () => {
        mcpEvictMock.mockRejectedValue(new Error("evict boom"));
        const provider = {
          health: "discovery-timed-out",
          label: "MCP",
          tools: vi.fn().mockResolvedValue([]),
          lastErrorMessage: "x",
        } as unknown as GracefulMcpProvider;
        mcpBorrowMock.mockResolvedValue(provider);
        agentPoolGetMock.mockResolvedValue(
          makeSpec({ tools: [{ kind: "mcp_server", mcpServerId: "mcp-1" }] }),
        );

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        // The evictWithCooldown.catch is fire-and-forget; flush the microtask.
        await vi.waitFor(() => {
          expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
              event: "mcp_evict_failed",
              mcpServerId: "mcp-1",
              err: { name: "Error", message: "evict boom" },
            }),
            "evictWithCooldown failed; pool state may be inconsistent",
          );
        });
      });
    });

    describe("non-MCP tool bindings", () => {
      it("resolves skill ids via skillPool.getMany and builds skills runtime", async () => {
        agentPoolGetMock.mockResolvedValue(
          makeSpec({ tools: [{ kind: "skill", skillId: "skill-1" }] }),
        );
        const skillSpecs = [{ skillId: "skill-1", name: "Py" }];
        skillPoolGetManyMock.mockResolvedValue(skillSpecs);
        buildSkillsRuntimeMock.mockReturnValue({
          tools: [{ name: "run_skill_script" }],
          promptBlock: "## Skills\n- Py",
        });

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(skillPoolGetManyMock).toHaveBeenCalledWith(["skill-1"]);
        expect(buildSkillsRuntimeMock).toHaveBeenCalledWith({ specs: skillSpecs });
        const args = agentArgs();
        expect(args.prompt).toEqual(expect.stringContaining("## Skills"));
        // ambient + skill tool
        expect((args.tools as unknown[]).length).toBe(2);
      });

      it("resolves builtin_tool names via buildBuiltinTools, dropping unknowns", async () => {
        agentPoolGetMock.mockResolvedValue(
          makeSpec({ tools: [{ kind: "builtin_tool", name: "web_search" }] }),
        );
        buildBuiltinToolsMock.mockReturnValue([{ name: "web_search" }]);

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(buildBuiltinToolsMock).toHaveBeenCalledWith(["web_search"]);
        // ambient + web_search
        expect((agentArgs().tools as unknown[]).length).toBe(2);
      });

      it("mounts extract_dataset_by_sql and data-source prompt when datasource binding present", async () => {
        agentPoolGetMock.mockResolvedValue(
          makeSpec({ tools: [{ kind: "datasource", dataSourceId: "ds-1" }] }),
        );
        buildDataSourcesPromptBlockMock.mockResolvedValue({ promptBlock: "## Data Sources\n- ds1" });

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(buildDataSourcesPromptBlockMock).toHaveBeenCalledWith(["ds-1"]);
        expect(buildExtractDatasetToolMock).toHaveBeenCalledWith(["ds-1"]);
        const args = agentArgs();
        expect(args.prompt).toEqual(expect.stringContaining("## Data Sources"));
        // ambient + extract_dataset
        expect((args.tools as unknown[]).length).toBe(2);
      });

      it("omits extract_dataset tool when no datasource binding present", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec());

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(buildExtractDatasetToolMock).not.toHaveBeenCalled();
      });

      it("mounts run_ssh_command + list_ssh_hosts and ssh prompt when ssh_server binding present", async () => {
        agentPoolGetMock.mockResolvedValue(
          makeSpec({ tools: [{ kind: "ssh_server", sshServerId: "ssh-1" }] }),
        );
        buildSshHostsPromptBlockMock.mockResolvedValue({ promptBlock: "## SSH Hosts\n- host1" });

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(buildSshHostsPromptBlockMock).toHaveBeenCalledWith(["ssh-1"]);
        expect(buildRunSshCommandToolMock).toHaveBeenCalledWith({ agentSshServerIds: ["ssh-1"] });
        expect(buildListSshHostsToolMock).toHaveBeenCalledWith({ agentSshServerIds: ["ssh-1"] });
        const args = agentArgs();
        expect(args.prompt).toEqual(expect.stringContaining("## SSH Hosts"));
        // ambient + run_ssh + list_ssh
        expect((args.tools as unknown[]).length).toBe(3);
      });

      it("mounts fetch_calendar_events and calendar prompt when calendar binding present", async () => {
        agentPoolGetMock.mockResolvedValue(
          makeSpec({ tools: [{ kind: "calendar", calendarCredentialId: "cal-1" }] }),
        );
        buildCalendarPromptBlockMock.mockResolvedValue({ promptBlock: "## Calendar\n- cal1" });

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(buildCalendarPromptBlockMock).toHaveBeenCalledWith(["cal-1"]);
        expect(buildFetchCalendarEventsToolMock).toHaveBeenCalledWith({
          agentCalendarCredentialIds: ["cal-1"],
        });
        const args = agentArgs();
        expect(args.prompt).toEqual(expect.stringContaining("## Calendar"));
        // ambient + fetch_calendar
        expect((args.tools as unknown[]).length).toBe(2);
      });
    });

    describe("supervisor role", () => {
      it("builds supervisor runtime, sets holder, and excludes safety policy when role is supervisor with ctx", async () => {
        const supTool = { name: "delegate_to_agent" };
        buildSupervisorRuntimeMock.mockResolvedValue({
          tools: [supTool],
          catalogPromptBlock: "## Catalog\n- agent-a",
        });
        agentPoolGetMock.mockResolvedValue(
          makeSpec({ agentId: "sup-1", role: "supervisor", prompt: "Delegate work." }),
        );

        const result = await buildBuiltinAgents(["sup-1"], mockLogger, { userId: "user-1" });

        expect(buildSupervisorRuntimeMock).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: "user-1",
            supervisorAgentId: "sup-1",
          }),
        );
        expect(result.supervisorRunHolders.has("sup-1")).toBe(true);
        expect(result.supervisorRunHolders.get("sup-1")).toEqual({
          current: undefined,
          threadId: undefined,
        });
        const args = agentArgs();
        expect(args.prompt).toEqual(expect.stringContaining("Delegate work."));
        expect(args.prompt).toEqual(expect.stringContaining("## Catalog"));
        expect(args.prompt).not.toEqual(expect.stringContaining(SAFETY_POLICY_BLOCK));
        // supervisor tool + ambient
        expect((args.tools as unknown[]).length).toBe(2);
      });

      it("records supervisor_build_failed degradation when buildSupervisorRuntime throws", async () => {
        buildSupervisorRuntimeMock.mockRejectedValue(new Error("catalog query failed"));
        agentPoolGetMock.mockResolvedValue(
          makeSpec({ agentId: "sup-1", role: "supervisor", name: "Super" }),
        );

        const result = await buildBuiltinAgents(["sup-1"], mockLogger, { userId: "user-1" });

        expect(result.degradations.get("sup-1")).toEqual([
          {
            ref: "sup-1",
            refName: "Super",
            reason: "supervisor_build_failed",
            message: "catalog query failed",
          },
        ]);
        // Holder is created before the build attempt, so it remains.
        expect(result.supervisorRunHolders.has("sup-1")).toBe(true);
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "supervisor_build_failed",
            agentId: "sup-1",
            err: "catalog query failed",
          }),
          "supervisor runtime build failed; agent will run without delegation tools",
        );
      });

      it("skips supervisor tools and logs debug when role is supervisor but no ctx is provided", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec({ agentId: "sup-1", role: "supervisor" }));

        const result = await buildBuiltinAgents(["sup-1"], mockLogger);

        expect(buildSupervisorRuntimeMock).not.toHaveBeenCalled();
        expect(result.supervisorRunHolders.size).toBe(0);
        expect(mockLogger.debug).toHaveBeenCalledWith(
          { event: "supervisor_tools_skipped", agentId: "sup-1" },
          "supervisor tools skipped: no user context (programmatic build)",
        );
        // Supervisor with no prompt + no ctx → composedPrompt undefined.
        expect(agentArgs().prompt).toBeUndefined();
      });

      it("resolves orchestration mode directive for supervisor when ctx.mode is set", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec({ role: "supervisor" }));

        await buildBuiltinAgents(["sup-1"], mockLogger, { userId: "user-1", mode: "auto" });

        expect(resolveOrchestrationModeMock).toHaveBeenCalledWith("auto");
        expect(agentArgs().prompt).toEqual(expect.stringContaining("MODE_DIRECTIVE"));
      });

      it("omits mode directive when supervisor has no ctx.mode", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec({ role: "supervisor", prompt: "P" }));

        await buildBuiltinAgents(["sup-1"], mockLogger, { userId: "user-1" });

        expect(resolveOrchestrationModeMock).not.toHaveBeenCalled();
        expect(agentArgs().prompt).not.toEqual(expect.stringContaining("MODE_DIRECTIVE"));
      });
    });

    describe("evaluator role", () => {
      it("mounts submit_evaluation_scores tool when role is evaluator", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec({ role: "evaluator" }));

        await buildBuiltinAgents(["agent-1"], mockLogger, {
          userId: "user-1",
          context: { expectedDimensionIds: ["dim-1", "dim-2"] },
        });

        expect(buildSubmitEvaluationScoresToolMock).toHaveBeenCalledWith({
          expectedDimensionIds: ["dim-1", "dim-2"],
        });
        const tools = agentArgs().tools as unknown[];
        expect(tools.some((t) => (t as { name: string }).name === "submit_evaluation_scores")).toBe(true);
      });

      it("mounts evaluator tool when initiator is evaluator even if role is null", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec({ role: null }));

        await buildBuiltinAgents(["agent-1"], mockLogger, {
          userId: "user-1",
          initiator: "evaluator",
        });

        expect(buildSubmitEvaluationScoresToolMock).toHaveBeenCalledWith({
          expectedDimensionIds: [],
        });
      });

      it("defaults expectedDimensionIds to empty array when context is missing", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec({ role: "evaluator" }));

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(buildSubmitEvaluationScoresToolMock).toHaveBeenCalledWith({
          expectedDimensionIds: [],
        });
      });
    });

    describe("tester role", () => {
      it("mounts tester tools when role is tester and ctx.userId is present", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec({ role: "tester" }));

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1", isAdmin: true });

        expect(buildTesterToolsMock).toHaveBeenCalledWith({
          userId: "user-1",
          isAdmin: true,
          isEditor: undefined,
        });
        const tools = agentArgs().tools as unknown[];
        expect(tools.some((t) => (t as { name: string }).name === "run_test_case")).toBe(true);
      });

      it("skips tester tools when role is tester but no ctx.userId is present", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec({ role: "tester" }));

        await buildBuiltinAgents(["agent-1"], mockLogger);

        expect(buildTesterToolsMock).not.toHaveBeenCalled();
      });
    });

    describe("model resolution failure", () => {
      it("records model_resolve_failed degradation and skips agent when resolveLanguageModel throws", async () => {
        agentPoolGetMock.mockResolvedValue(
          makeSpec({ agentId: "agent-1", modelProvider: "unknown", model: "foo" }),
        );
        resolveLanguageModelMock.mockImplementation(() => {
          throw new Error("Unsupported model provider");
        });

        const result = await buildBuiltinAgents(["agent-1"], mockLogger);

        expect(result.agents).toEqual({});
        expect(result.degradations.get("agent-1")).toEqual([
          {
            ref: "unknown/foo",
            refName: null,
            reason: "model_resolve_failed",
            message: "Unsupported model provider",
          },
        ]);
        expect(BuiltInAgentCtorMock).not.toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "model_resolve_failed",
            agentId: "agent-1",
            modelProvider: "unknown",
            model: "foo",
          }),
          "model resolution failed; skipping agent",
        );
      });
    });

    describe("tool approval policy", () => {
      it("includes AUTO_APPROVAL_POLICY_BLOCK when toolApprovalMode is auto", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec({ toolApprovalMode: "auto" }));

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(agentArgs().prompt).toEqual(expect.stringContaining(AUTO_APPROVAL_POLICY_BLOCK));
      });

      it("includes ALWAYS_APPROVAL_POLICY_BLOCK when toolApprovalMode is always", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec({ toolApprovalMode: "always" }));

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(agentArgs().prompt).toEqual(expect.stringContaining(ALWAYS_APPROVAL_POLICY_BLOCK));
      });

      it("includes neither approval block when toolApprovalMode is never", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec({ toolApprovalMode: "never" }));

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        const prompt = agentArgs().prompt as string;
        expect(prompt).not.toContain(AUTO_APPROVAL_POLICY_BLOCK);
        expect(prompt).not.toContain(ALWAYS_APPROVAL_POLICY_BLOCK);
      });
    });

    describe("chart & html page prompt blocks", () => {
      it("builds chart prompt block when generate_echarts_config is bound on non-supervisor", async () => {
        agentPoolGetMock.mockResolvedValue(
          makeSpec({ tools: [{ kind: "builtin_tool", name: "generate_echarts_config" }] }),
        );

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(buildChartPromptBlockMock).toHaveBeenCalledWith({
          hasDataSource: false,
          hasSandbox: false,
        });
        expect(agentArgs().prompt).toEqual(expect.stringContaining("CHART_PROMPT"));
      });

      it("passes hasDataSource true to chart block when datasource is also bound", async () => {
        agentPoolGetMock.mockResolvedValue(
          makeSpec({
            tools: [
              { kind: "builtin_tool", name: "generate_echarts_config" },
              { kind: "datasource", dataSourceId: "ds-1" },
            ],
          }),
        );

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(buildChartPromptBlockMock).toHaveBeenCalledWith({
          hasDataSource: true,
          hasSandbox: false,
        });
      });

      it("passes hasSandbox true to chart block when run_code_in_sandbox is also bound", async () => {
        agentPoolGetMock.mockResolvedValue(
          makeSpec({
            tools: [
              { kind: "builtin_tool", name: "generate_echarts_config" },
              { kind: "builtin_tool", name: "run_code_in_sandbox" },
            ],
          }),
        );

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(buildChartPromptBlockMock).toHaveBeenCalledWith({
          hasDataSource: false,
          hasSandbox: true,
        });
      });

      it("skips chart prompt block for supervisor even when generate_echarts_config is bound", async () => {
        agentPoolGetMock.mockResolvedValue(
          makeSpec({
            role: "supervisor",
            tools: [{ kind: "builtin_tool", name: "generate_echarts_config" }],
          }),
        );

        await buildBuiltinAgents(["sup-1"], mockLogger, { userId: "user-1" });

        expect(buildChartPromptBlockMock).not.toHaveBeenCalled();
      });

      it("builds html page prompt block when generate_html_page is bound on non-supervisor", async () => {
        agentPoolGetMock.mockResolvedValue(
          makeSpec({ tools: [{ kind: "builtin_tool", name: "generate_html_page" }] }),
        );

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(buildHtmlPagePromptBlockMock).toHaveBeenCalled();
        expect(agentArgs().prompt).toEqual(expect.stringContaining("HTML_PAGE_PROMPT"));
      });

      it("includes html page prompt block for supervisor when tool is bound", async () => {
        agentPoolGetMock.mockResolvedValue(
          makeSpec({
            role: "supervisor",
            tools: [{ kind: "builtin_tool", name: "generate_html_page" }],
          }),
        );

        await buildBuiltinAgents(["sup-1"], mockLogger, { userId: "user-1" });

        expect(buildHtmlPagePromptBlockMock).toHaveBeenCalled();
      });
    });

    describe("prompt composition", () => {
      it("includes SHARED_STATE_PROMPT_BLOCK when sharedStateEnabled is true", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec({ sharedStateEnabled: true }));

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(agentArgs().prompt).toEqual(expect.stringContaining(SHARED_STATE_PROMPT_BLOCK));
      });

      it("excludes SHARED_STATE_PROMPT_BLOCK when sharedStateEnabled is false and role is not supervisor/tester", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec({ sharedStateEnabled: false, role: null }));

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(agentArgs().prompt).not.toEqual(expect.stringContaining(SHARED_STATE_PROMPT_BLOCK));
      });

      it("injects page context snapshot when ctx.context.pageContext is a non-empty string", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec());

        await buildBuiltinAgents(["agent-1"], mockLogger, {
          userId: "user-1",
          context: { pageContext: "## Current page\n- foo" },
        });

        const prompt = agentArgs().prompt as string;
        expect(prompt).toContain("## Active Page Context Snapshot (Read-Only Reference)");
        expect(prompt).toContain("## Current page");
      });

      it("skips page context snapshot when ctx.context.pageContext is blank", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec());

        await buildBuiltinAgents(["agent-1"], mockLogger, {
          userId: "user-1",
          context: { pageContext: "   " },
        });

        const prompt = agentArgs().prompt as string;
        expect(prompt).not.toContain("## Active Page Context Snapshot");
      });

      it("skips page context snapshot when ctx.context.pageContext is not a string", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec());

        await buildBuiltinAgents(["agent-1"], mockLogger, {
          userId: "user-1",
          context: { pageContext: { object: "not a string" } },
        });

        const prompt = agentArgs().prompt as string;
        expect(prompt).not.toContain("## Active Page Context Snapshot");
      });

      it("trims spec.prompt before appending to composed prompt", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec({ prompt: "  \nKeep it short.\n  " }));

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(agentArgs().prompt).toEqual(expect.stringContaining("Keep it short."));
      });

      it("omits spec.prompt when it is blank whitespace", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec({ prompt: "   " }));

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        // Safety policy + error policy still present; no stray whitespace block.
        const prompt = agentArgs().prompt as string;
        expect(prompt).toContain(SAFETY_POLICY_BLOCK);
        expect(prompt.startsWith("   ")).toBe(false);
      });
    });

    describe("pipeline integration", () => {
      it("invokes buildServerToolMiddlewares with approval mode and exempt tool set", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec({ toolApprovalMode: "auto" }));

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1", runId: "run-1" });

        expect(buildServerToolMiddlewaresMock).toHaveBeenCalledTimes(1);
        const callArgs = buildServerToolMiddlewaresMock.mock.calls[0][0] as Record<string, unknown>;
        expect(callArgs.approvalMode).toBe("auto");
        expect(callArgs.exemptTools).toBeInstanceOf(Set);
        const exempt = callArgs.exemptTools as Set<string>;
        expect(exempt.has("delegate_to_agent")).toBe(true);
        expect(exempt.has("get_current_datetime")).toBe(true);
        expect(exempt.has("submit_evaluation_scores")).toBe(true);
      });

      it("invokes composeToolPipeline and wraps each server tool", async () => {
        agentPoolGetMock.mockResolvedValue(
          makeSpec({ tools: [{ kind: "builtin_tool", name: "web_search" }] }),
        );
        buildBuiltinToolsMock.mockReturnValue([{ name: "web_search" }]);

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(composeToolPipelineMock).toHaveBeenCalledTimes(1);
        // 2 tools (web_search + ambient) each passed through toolPipeline
        const tools = agentArgs().tools as unknown[];
        expect(tools).toHaveLength(2);
      });

      it("invokes composePipelinedMcpProvider for each borrowed provider", async () => {
        const p1 = readyProvider("A");
        const p2 = readyProvider("B");
        mcpBorrowMock.mockResolvedValueOnce(p1).mockResolvedValueOnce(p2);
        agentPoolGetMock.mockResolvedValue(
          makeSpec({
            tools: [
              { kind: "mcp_server", mcpServerId: "mcp-a" },
              { kind: "mcp_server", mcpServerId: "mcp-b" },
            ],
          }),
        );

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1" });

        expect(composePipelinedMcpProviderMock).toHaveBeenCalledTimes(2);
        expect(composePipelinedMcpProviderMock).toHaveBeenNthCalledWith(1, p1, [], expect.any(Object));
        expect(composePipelinedMcpProviderMock).toHaveBeenNthCalledWith(2, p2, [], expect.any(Object));
      });

      it("marks headless true when ctx.mode is async", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec());

        await buildBuiltinAgents(["agent-1"], mockLogger, { userId: "user-1", mode: "async" });

        const pipelineCtx = composeToolPipelineMock.mock.calls[0][1] as Record<string, unknown>;
        expect(pipelineCtx.isHeadless).toBe(true);
      });

      it("marks headless true when ctx.initiator is schedule", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec());

        await buildBuiltinAgents(["agent-1"], mockLogger, {
          userId: "user-1",
          initiator: "schedule",
        });

        const pipelineCtx = composeToolPipelineMock.mock.calls[0][1] as Record<string, unknown>;
        expect(pipelineCtx.isHeadless).toBe(true);
      });

      it("marks headless false for interactive user runs", async () => {
        agentPoolGetMock.mockResolvedValue(makeSpec());

        await buildBuiltinAgents(["agent-1"], mockLogger, {
          userId: "user-1",
          initiator: "user",
          mode: "sync",
        });

        const pipelineCtx = composeToolPipelineMock.mock.calls[0][1] as Record<string, unknown>;
        expect(pipelineCtx.isHeadless).toBe(false);
      });
    });

    describe("combined / multi-agent degradation", () => {
      it("collects degradations per-agent across a mixed batch", async () => {
        // agent-1: spec missing → spec_skip
        // agent-2: model resolve fails → model_resolve_failed
        // agent-3: healthy → built
        agentPoolGetMock
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(makeSpec({ agentId: "agent-2", modelProvider: "bad" }))
          .mockResolvedValueOnce(makeSpec({ agentId: "agent-3" }));
        // First resolve call (agent-2) throws; subsequent (agent-3) succeed.
        resolveLanguageModelMock
          .mockImplementationOnce(() => {
            throw new Error("bad provider");
          })
          .mockReturnValue({ model: "openai:gpt-4o" });

        const result = await buildBuiltinAgents(
          ["agent-1", "agent-2", "agent-3"],
          mockLogger,
          { userId: "user-1" },
        );

        expect(Object.keys(result.agents)).toEqual(["agent-3"]);
        expect(result.degradations.get("agent-1")![0].reason).toBe("spec_skip");
        expect(result.degradations.get("agent-2")![0].reason).toBe("model_resolve_failed");
        expect(result.degradations.has("agent-3")).toBe(false);
      });
    });
  });
});
