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

vi.mock("@/lib/access/agent-visibility", () => ({
  isAgentVisibleTo: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/web-auto/discovery.server", () => ({
  discoverPublicPlaywrightMcpServer: vi.fn(),
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
    const validUuid = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";

    it("requires category and non-empty name", () => {
      const valid = createTestSuiteSchema.safeParse({
        category: "verification",
        name: "My Suite",
        mcpServerId: validUuid,
      });
      expect(valid.success).toBe(true);

      const missingName = createTestSuiteSchema.safeParse({
        category: "verification",
        mcpServerId: validUuid,
      });
      expect(missingName.success).toBe(false);

      const missingCategory = createTestSuiteSchema.safeParse({
        name: "My Suite",
      });
      expect(missingCategory.success).toBe(false);
    });

    it("rejects category-inapplicable fields (discriminated union)", () => {
      // verification requires mcpServerId
      expect(
        createTestSuiteSchema.safeParse({ category: "verification", name: "My Suite" }).success,
      ).toBe(false);

      // evaluation requires agentId
      expect(
        createTestSuiteSchema.safeParse({ category: "evaluation", name: "My Suite" }).success,
      ).toBe(false);

      // evaluation rejects mcpServerId (verification/web-auto-only field)
      expect(
        createTestSuiteSchema.safeParse({
          category: "evaluation",
          name: "My Suite",
          agentId: "agent-1",
          mcpServerId: validUuid,
        }).success,
      ).toBe(false);

      // verification rejects agentId (evaluation-only field)
      expect(
        createTestSuiteSchema.safeParse({
          category: "verification",
          name: "My Suite",
          mcpServerId: validUuid,
          agentId: "agent-1",
        }).success,
      ).toBe(false);
    });
  });

  describe("Tool Execution", () => {
    const ctx = { userId: "user-123", isAdmin: false, isEditor: true };
    const tool = buildCreateTestSuiteTool(ctx);

    it("has tool name create_test_suite", () => {
      expect(tool.name).toBe("create_test_suite");
    });

    it("rejects non-editor callers", async () => {
      const nonEditorTool = buildCreateTestSuiteTool({ userId: "user-999", isEditor: false, isAdmin: false });
      await expect(
        nonEditorTool.execute!({
          category: "verification",
          name: "MCP Suite",
          mcpServerId: "server-uuid-1",
        }),
      ).rejects.toThrow(/Editor or admin role required/);
    });

    it("creates verification suite", async () => {
      // Server lookup succeeds
      mockLimit.mockResolvedValueOnce([
        {
          id: "server-uuid-1",
          name: "github-mcp",
          visibility: "private",
          createdBy: "user-123",
        },
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
        mcpServerId: "server-uuid-1",
      })) as CreateTestSuiteResult;

      expect(result.category).toBe("verification");
      expect(result.suite.id).toBe("suite-ver-uuid");
      expect(result.suite.mcpServerId).toBe("server-uuid-1");
      expect(result.suite.serverName).toBe("github-mcp");
      expect(result.suite.caseCount).toBe(0);
      expect(result.suite.enabled).toBe(true);
    });

    it("rejects binding another user's private MCP server", async () => {
      mockLimit.mockResolvedValueOnce([
        {
          id: "server-other",
          name: "secret-mcp",
          visibility: "private",
          createdBy: "other-user",
        },
      ]);

      await expect(
        tool.execute!({
          category: "verification",
          name: "Hacked Suite",
          mcpServerId: "server-other",
        }),
      ).rejects.toThrow(/not found or access denied/);
    });

    it("creates evaluation suite", async () => {
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

    it("rejects binding an agent that is not visible to the user", async () => {
      const { isAgentVisibleTo } = await import("@/lib/access/agent-visibility");
      vi.mocked(isAgentVisibleTo).mockResolvedValueOnce(false);

      await expect(
        tool.execute!({
          category: "evaluation",
          name: "Secret Agent Suite",
          agentId: "private-agent-other",
        }),
      ).rejects.toThrow(/not found or access denied/);
    });

    it("creates web-auto suite auto-discovering the public playwright server", async () => {
      const { discoverPublicPlaywrightMcpServer } = await import("@/lib/web-auto/discovery.server");
      vi.mocked(discoverPublicPlaywrightMcpServer).mockResolvedValueOnce("playwright-server-uuid");

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

    it("leaves web-auto suite mcpServerId null when no public playwright server exists", async () => {
      const { discoverPublicPlaywrightMcpServer } = await import("@/lib/web-auto/discovery.server");
      vi.mocked(discoverPublicPlaywrightMcpServer).mockResolvedValueOnce(null);

      mockReturning.mockResolvedValueOnce([
        {
          id: "suite-web-empty-uuid",
          name: "E2E Checkout Flow",
          description: null,
          mcpServerId: null,
          timeoutSec: 300,
          enabled: true,
          visibility: "private",
        },
      ]);

      const result = (await tool.execute!({
        category: "web-auto",
        name: "E2E Checkout Flow",
      })) as CreateTestSuiteResult;

      expect(result.suite.mcpServerId).toBeNull();
    });

    it("binds an explicitly provided private playwright server", async () => {
      mockLimit.mockResolvedValueOnce([
        { id: "private-pw-uuid", visibility: "private", createdBy: "user-123" },
      ]);

      mockReturning.mockResolvedValueOnce([
        {
          id: "suite-web-manual-uuid",
          name: "E2E Checkout Flow",
          description: null,
          mcpServerId: "private-pw-uuid",
          timeoutSec: 300,
          enabled: true,
          visibility: "private",
        },
      ]);

      const result = (await tool.execute!({
        category: "web-auto",
        name: "E2E Checkout Flow",
        mcpServerId: "private-pw-uuid",
      })) as CreateTestSuiteResult;

      expect(result.suite.mcpServerId).toBe("private-pw-uuid");
    });

    it("rejects an explicit mcpServerId that is another user's private server", async () => {
      mockLimit.mockResolvedValueOnce([
        { id: "other-pw", visibility: "private", createdBy: "other-user" },
      ]);

      await expect(
        tool.execute!({
          category: "web-auto",
          name: "Hacked Suite",
          mcpServerId: "other-pw",
        }),
      ).rejects.toThrow(/not found or access denied/);
    });
  });
});
