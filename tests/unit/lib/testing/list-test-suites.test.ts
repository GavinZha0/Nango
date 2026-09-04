import { describe, it, expect, vi, beforeEach } from "vitest";
import { listTestSuitesSchema, buildListTestSuitesTool } from "@/lib/testing/tools/list-test-suites";
import type { ListTestSuitesResult } from "@/lib/testing/types";

// Mock db
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockLeftJoin = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: (args: unknown) => mockSelect(args),
  },
}));

describe("list_test_suites tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ leftJoin: mockLeftJoin, where: mockWhere, orderBy: mockOrderBy });
    mockLeftJoin.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
  });

  describe("Schema Validation", () => {
    it("requires category and accepts valid categories", () => {
      const valid = listTestSuitesSchema.safeParse({ category: "verification" });
      expect(valid.success).toBe(true);

      const invalid = listTestSuitesSchema.safeParse({});
      expect(invalid.success).toBe(false);

      const unknownCat = listTestSuitesSchema.safeParse({ category: "performance" });
      expect(unknownCat.success).toBe(false);
    });

    it("accepts optional suiteId and enabledOnly", () => {
      const suiteUuid = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";
      const valid = listTestSuitesSchema.safeParse({
        category: "evaluation",
        suiteId: suiteUuid,
        enabledOnly: true,
      });
      expect(valid.success).toBe(true);
      if (valid.success) {
        expect(valid.data.enabledOnly).toBe(true);
        expect(valid.data.suiteId).toBe(suiteUuid);
      }
    });

    it("defaults enabledOnly to false", () => {
      const parsed = listTestSuitesSchema.parse({ category: "web-auto" });
      expect(parsed.enabledOnly).toBe(false);
    });
  });

  describe("Tool Execution", () => {
    const ctx = { userId: "user-123", isAdmin: false };
    const tool = buildListTestSuitesTool(ctx);

    it("has tool name list_test_suites", () => {
      expect(tool.name).toBe("list_test_suites");
    });

    it("queries verification suites and returns mapped fields", async () => {
      mockOrderBy.mockResolvedValueOnce([
        {
          id: "suite-ver-1",
          name: "MCP Docs Suite",
          description: "Search tools verification",
          mcpServerId: "server-mcp-1",
          serverName: "docs-server",
          caseCount: 8,
          enabled: true,
          visibility: "private",
        },
      ]);

      const result = (await tool.execute!({ category: "verification" })) as ListTestSuitesResult;

      expect(result.category).toBe("verification");
      expect(result.total).toBe(1);
      expect(result.suites[0]).toEqual({
        id: "suite-ver-1",
        name: "MCP Docs Suite",
        description: "Search tools verification",
        mcpServerId: "server-mcp-1",
        serverName: "docs-server",
        caseCount: 8,
        enabled: true,
        visibility: "private",
      });
    });

    it("queries evaluation suites and returns mapped fields", async () => {
      mockOrderBy.mockResolvedValueOnce([
        {
          id: "suite-eval-1",
          name: "Support Agent Eval",
          description: "Quality benchmark",
          agentId: "agent-support",
          agentSource: "builtin",
          evaluatorAgentId: "evaluator-1",
          caseCount: 4,
          enabled: true,
          visibility: "public",
        },
      ]);

      const result = (await tool.execute!({ category: "evaluation" })) as ListTestSuitesResult;

      expect(result.category).toBe("evaluation");
      expect(result.total).toBe(1);
      expect(result.suites[0]).toEqual({
        id: "suite-eval-1",
        name: "Support Agent Eval",
        description: "Quality benchmark",
        agentId: "agent-support",
        agentSource: "builtin",
        evaluatorAgentId: "evaluator-1",
        caseCount: 4,
        enabled: true,
        visibility: "public",
      });
    });

    it("queries web-auto suites and returns mapped fields", async () => {
      mockOrderBy.mockResolvedValueOnce([
        {
          id: "suite-web-1",
          name: "Checkout UI Test",
          description: "Playwright automated checkout",
          mcpServerId: "playwright-service",
          timeoutSec: 300,
          caseCount: 12,
          enabled: false,
          visibility: "private",
        },
      ]);

      const result = (await tool.execute!({ category: "web-auto" })) as ListTestSuitesResult;

      expect(result.category).toBe("web-auto");
      expect(result.total).toBe(1);
      expect(result.suites[0]).toEqual({
        id: "suite-web-1",
        name: "Checkout UI Test",
        description: "Playwright automated checkout",
        mcpServerId: "playwright-service",
        timeoutSec: 300,
        caseCount: 12,
        enabled: false,
        visibility: "private",
      });
    });
  });
});
