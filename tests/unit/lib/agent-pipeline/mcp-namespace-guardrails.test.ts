import { describe, expect, it, vi } from "vitest";

const { mockRunToolApprovalGate, mockGetToolRiskOverride } = vi.hoisted(() => ({
  mockRunToolApprovalGate: vi.fn(async () => ({
    proceed: false as const,
    result: { isError: true, message: "approval_required" },
  })),
  mockGetToolRiskOverride: vi.fn(),
}));

vi.mock("@/lib/runner/tool-approval", () => ({
  runToolApprovalGate: mockRunToolApprovalGate,
}));

vi.mock("@/lib/agent-pipeline/guardrail-service", () => ({
  getToolRiskOverride: mockGetToolRiskOverride,
  getGuardrailConfigCache: () => ({ safetyPolicies: [], riskOverrides: [] }),
  recordInterceptionLog: vi.fn(async () => {}),
}));

import { composePipelinedMcpProvider } from "@/lib/agent-pipeline/compose";
import { toolApprovalMiddleware } from "@/lib/agent-pipeline/middlewares";
import { buildMcpRiskMeta, evaluateToolRisk } from "@/lib/agent-pipeline/risk-registry";
import { isExternalTool } from "@/lib/agent-pipeline/sanitizer";
import type { MiddlewareContext } from "@/lib/agent-pipeline/types";
import type { GracefulMcpProvider } from "@/lib/mcp/client-providers";
import { MCP_TOOL_ANNOTATIONS, namespaceMcpProvider } from "@/lib/mcp/tool-namespace";

describe("MCP namespace guardrails (B1, B2, B3, D4)", () => {
  it("B1: never exempts MCP tools from approval even if name matches APPROVAL_EXEMPT_TOOLS", async () => {
    mockRunToolApprovalGate.mockClear();

    const baseProvider: GracefulMcpProvider = {
      label: "evil-mcp",
      health: "ready",
      lastErrorMessage: null,
      close: vi.fn(async () => {}),
      tools: vi.fn(async () => ({
        get_skill: {
          name: "get_skill",
          execute: vi.fn(async () => "ok"),
        },
      })) as unknown as GracefulMcpProvider["tools"],
    };

    const namespaced = namespaceMcpProvider(baseProvider, {
      serverId: "srv-1",
      prefix: "evil-mcp",
    });
    const ctx: MiddlewareContext = {
      runId: "run-1",
      userId: "user-1",
      isHeadless: false,
      metadata: {},
    };
    const pipelined = composePipelinedMcpProvider(
      namespaced,
      [
        toolApprovalMiddleware({
          approvalMode: "always",
          exemptTools: new Set(["get_skill", "evil-mcp_get_skill"]),
        }),
      ],
      ctx,
    );

    const tools = (await pipelined.tools()) as unknown as Record<
      string,
      { execute: (args: unknown) => Promise<unknown> }
    >;
    const result = await tools["evil-mcp_get_skill"].execute({});

    expect(mockRunToolApprovalGate).toHaveBeenCalledTimes(1);
    expect(mockRunToolApprovalGate).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "evil-mcp_get_skill",
        mcp: expect.objectContaining({
          mcpServerId: "srv-1",
          rawToolName: "get_skill",
        }),
      }),
    );
    expect(result).toEqual({ isError: true, message: "approval_required" });
  });

  it("B2: treats MCP tools as external even if raw name collides with a built-in tool", () => {
    expect(isExternalTool("read_file")).toBe(false);
    expect(
      isExternalTool("read_file", {
        mcpServerId: "srv-1",
        rawToolName: "read_file",
      }),
    ).toBe(true);
  });

  it("B3: evaluates MCP risk overrides using mcpServerId + rawToolName and ignores BUILTIN_TOOL_RISK_MAP", () => {
    mockGetToolRiskOverride.mockReset();
    mockGetToolRiskOverride.mockImplementation(
      (source: string, serverId: string | undefined, toolName: string) => {
        if (source === "mcp" && serverId === "srv-1" && toolName === "get_current_datetime") {
          return {
            enabled: true,
            riskLevel: "critical",
            headlessAllowed: false,
            requireApproval: "always",
          };
        }
        return undefined;
      },
    );

    const res = evaluateToolRisk(
      "Hal9000_vw-mcp_get_current_datetime",
      {},
      buildMcpRiskMeta({
        mcpServerId: "srv-1",
        rawToolName: "get_current_datetime",
      }),
    );

    expect(mockGetToolRiskOverride).toHaveBeenCalledWith(
      "mcp",
      "srv-1",
      "get_current_datetime",
    );
    expect(res.riskLevel).toBe("critical");
    expect(res.requiresApproval).toBe(true);
    expect(res.headlessAllowed).toBe(false);
  });

  it("D4: propagates MCP annotations through namespaceMcpProvider into pipeline ToolCall", async () => {
    mockRunToolApprovalGate.mockClear();

    const baseProvider: GracefulMcpProvider = {
      label: "db-mcp",
      health: "ready",
      lastErrorMessage: null,
      close: vi.fn(async () => {}),
      tools: vi.fn(async () => ({
        drop_table: {
          name: "drop_table",
          [MCP_TOOL_ANNOTATIONS]: { destructiveHint: true, readOnlyHint: false },
          execute: vi.fn(async () => "ok"),
        },
      })) as unknown as GracefulMcpProvider["tools"],
    };

    const namespaced = namespaceMcpProvider(baseProvider, {
      serverId: "srv-db",
      prefix: "db-mcp",
    });
    const ctx: MiddlewareContext = {
      runId: "run-2",
      userId: "user-1",
      isHeadless: false,
      metadata: {},
    };
    const pipelined = composePipelinedMcpProvider(
      namespaced,
      [toolApprovalMiddleware({ approvalMode: "auto", exemptTools: new Set() })],
      ctx,
    );

    const tools = (await pipelined.tools()) as unknown as Record<
      string,
      { execute: (args: unknown) => Promise<unknown> }
    >;
    await tools["db-mcp_drop_table"].execute({});

    expect(mockRunToolApprovalGate).toHaveBeenCalledWith(
      expect.objectContaining({
        mcp: {
          mcpServerId: "srv-db",
          rawToolName: "drop_table",
          annotations: { destructiveHint: true, readOnlyHint: false },
        },
      }),
    );

    const risk = evaluateToolRisk(
      "db-mcp_drop_table",
      {},
      buildMcpRiskMeta({
        mcpServerId: "srv-db",
        rawToolName: "drop_table",
        annotations: { destructiveHint: true, readOnlyHint: false },
      }),
    );
    expect(risk.riskLevel).toBe("critical");
    expect(risk.requiresApproval).toBe(true);
  });
});
