import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTestSuiteSchema,
  buildCreateTestSuiteTool,
} from "@/lib/testing/tools/create-test-suite";
import type { CreateTestSuiteResult } from "@/lib/testing/types";

// Mock db
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockReturning = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: (args: unknown) => mockSelect(args),
    insert: (table: unknown) => mockInsert(table),
  },
}));

describe("create_test_suite tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });
    mockLimit.mockResolvedValue([]);

    mockInsert.mockReturnValue({ values: mockValues });
    mockValues.mockReturnValue({ returning: mockReturning });
    mockReturning.mockResolvedValue([]);
  });

  describe("Schema Validation", () => {
    it("requires category and non-empty name", () => {
      const valid = createTestSuiteSchema.safeParse({
        category: "verification",
        name: "My Suite",
      });
      expect(valid.success).toBe(true);

      const missingName = createTestSuiteSchema.safeParse({
        category: "verification",
      });
      expect(missingName.success).toBe(false);

      const missingCategory = createTestSuiteSchema.safeParse({
        name: "My Suite",
      });
      expect(missingCategory.success).toBe(false);
    });
  });

  describe("Tool Execution", () => {
    const ctx = { userId: "user-123", isAdmin: false };
    const tool = buildCreateTestSuiteTool(ctx);

    it("has tool name create_test_suite", () => {
      expect(tool.name).toBe("create_test_suite");
    });

    it("creates verification suite requiring serverId", async () => {
      // Missing serverId throws
      await expect(
        tool.execute!({
          category: "verification",
          name: "MCP Verification Suite",
        }),
      ).rejects.toThrow(/serverId.*required/);

      // Server lookup succeeds
      mockLimit.mockResolvedValueOnce([
        { id: "server-uuid-1", name: "github-mcp" },
      ]);

      mockReturning.mockResolvedValueOnce([
        {
          id: "suite-ver-uuid",
          name: "MCP Verification Suite",
          description: "PR tools suite",
          category: "mcp",
          mcpServerId: "server-uuid-1",
          enabled: true,
          visibility: "private",
        },
      ]);

      const result = (await tool.execute!({
        category: "verification",
        name: "MCP Verification Suite",
        description: "PR tools suite",
        serverId: "server-uuid-1",
      })) as CreateTestSuiteResult;

      expect(result.category).toBe("verification");
      expect(result.suite.id).toBe("suite-ver-uuid");
      expect(result.suite.serverId).toBe("server-uuid-1");
      expect(result.suite.serverName).toBe("github-mcp");
      expect(result.suite.caseCount).toBe(0);
      expect(result.suite.enabled).toBe(true);
    });

    it("creates evaluation suite requiring agentId", async () => {
      // Missing agentId throws
      await expect(
        tool.execute!({
          category: "evaluation",
          name: "Support Agent Benchmark",
        }),
      ).rejects.toThrow(/agentId.*required/);

      mockReturning.mockResolvedValueOnce([
        {
          id: "suite-eval-uuid",
          name: "Support Agent Benchmark",
          description: null,
          agentId: "support-agent",
          agentSource: "builtin",
          evaluatorAgentId: null,
          enabled: true,
          visibility: "private",
        },
      ]);

      const result = (await tool.execute!({
        category: "evaluation",
        name: "Support Agent Benchmark",
        agentId: "support-agent",
      })) as CreateTestSuiteResult;

      expect(result.category).toBe("evaluation");
      expect(result.suite.id).toBe("suite-eval-uuid");
      expect(result.suite.agentId).toBe("support-agent");
      expect(result.suite.caseCount).toBe(0);
      expect(result.suite.enabled).toBe(true);
    });

    it("creates web-auto suite auto-discovering playwright server", async () => {
      // Auto-discovers Playwright server
      mockLimit.mockResolvedValueOnce([
        { id: "playwright-server-uuid" },
      ]);

      mockReturning.mockResolvedValueOnce([
        {
          id: "suite-web-uuid",
          name: "E2E Checkout Flow",
          description: null,
          mcpServerId: "playwright-server-uuid",
          timeoutSec: 300,
          enabled: true,
          visibility: "private",
        },
      ]);

      const result = (await tool.execute!({
        category: "web-auto",
        name: "E2E Checkout Flow",
      })) as CreateTestSuiteResult;

      expect(result.category).toBe("web-auto");
      expect(result.suite.id).toBe("suite-web-uuid");
      expect(result.suite.mcpServerId).toBe("playwright-server-uuid");
      expect(result.suite.caseCount).toBe(0);
      expect(result.suite.enabled).toBe(true);
    });
  });
});
