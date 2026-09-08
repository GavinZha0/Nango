import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTestSuiteSchema,
  buildCreateTestSuiteTool,
} from "@/lib/testing/tools/create-test-suite";
import type { CreateTestSuiteResult } from "@/lib/testing/types";

vi.mock("@/lib/db", async () => {
  const { createDrizzleMock } = await import("tests/unit/helpers");
  return { db: createDrizzleMock() };
});

import { db } from "@/lib/db";
import type { MockDrizzleDb } from "tests/unit/helpers";

const dbMock = db as unknown as MockDrizzleDb;

vi.mock("@/lib/access/agent-visibility", () => ({
  isAgentVisibleTo: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/web-auto/discovery.server", () => ({
  discoverPublicPlaywrightMcpServer: vi.fn(),
}));

describe("create_test_suite tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$reset();
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

    it("rejects category-inapplicable fields with actionable guidance", () => {
      // verification requires mcpServerId
      const verMissingMcp = createTestSuiteSchema.safeParse({ category: "verification", name: "My Suite" });
      expect(verMissingMcp.success).toBe(false);
      if (!verMissingMcp.success) {
        expect(verMissingMcp.error.issues[0]?.message).toMatch(
          /Field 'mcpServerId' \(UUID\) is required for 'verification' suites/,
        );
      }

      // evaluation requires agentId
      const evalMissingAgent = createTestSuiteSchema.safeParse({ category: "evaluation", name: "My Suite" });
      expect(evalMissingAgent.success).toBe(false);
      if (!evalMissingAgent.success) {
        expect(evalMissingAgent.error.issues[0]?.message).toMatch(
          /Field 'agentId' is required for 'evaluation' suites/,
        );
      }

      // evaluation rejects mcpServerId
      const evalWithMcp = createTestSuiteSchema.safeParse({
        category: "evaluation",
        name: "My Suite",
        agentId: "agent-1",
        mcpServerId: validUuid,
      });
      expect(evalWithMcp.success).toBe(false);
      if (!evalWithMcp.success) {
        expect(evalWithMcp.error.issues[0]?.message).toMatch(
          /Field 'mcpServerId' is not permitted in 'evaluation' suites/,
        );
      }

      // verification rejects agentId
      const verWithAgent = createTestSuiteSchema.safeParse({
        category: "verification",
        name: "My Suite",
        mcpServerId: validUuid,
        agentId: "agent-1",
      });
      expect(verWithAgent.success).toBe(false);
      if (!verWithAgent.success) {
        expect(verWithAgent.error.issues[0]?.message).toMatch(
          /Field 'agentId' is not permitted in 'verification' suites/,
        );
      }

      // web-auto rejects agentId
      const webWithAgent = createTestSuiteSchema.safeParse({
        category: "web-auto",
        name: "My Web Suite",
        agentId: "agent-1",
      });
      expect(webWithAgent.success).toBe(false);
      if (!webWithAgent.success) {
        expect(webWithAgent.error.issues[0]?.message).toMatch(
          /Field 'agentId' is not permitted in 'web-auto' suites/,
        );
      }
    });

    it("tolerates and strips unknown hallucinated fields (LLM tolerance contract)", () => {
      const parsed = createTestSuiteSchema.safeParse({
        category: "verification",
        name: "My Suite",
        mcpServerId: validUuid,
        bogusReasoningField: "I decided to test this MCP server because...",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect((parsed.data as Record<string, unknown>).bogusReasoningField).toBeUndefined();
      }
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
      dbMock.$enqueue(
        [
          {
            id: "server-uuid-1",
            name: "github-mcp",
            visibility: "private",
            createdBy: "user-123",
          },
        ],
        [
          {
            id: "suite-ver-uuid",
            name: "MCP Verification Suite",
            description: "PR tools suite",
            category: "mcp",
            mcpServerId: "server-uuid-1",
            enabled: true,
            visibility: "private",
          },
        ],
      );

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
      dbMock.$enqueue([
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
      dbMock.$enqueue([
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

      dbMock.$enqueue([
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

      dbMock.$enqueue([
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
      dbMock.$enqueue(
        [
          { id: "private-pw-uuid", visibility: "private", createdBy: "user-123" },
        ],
        [
          {
            id: "suite-web-manual-uuid",
            name: "E2E Checkout Flow",
            description: null,
            mcpServerId: "private-pw-uuid",
            timeoutSec: 300,
            enabled: true,
            visibility: "private",
          },
        ],
      );

      const result = (await tool.execute!({
        category: "web-auto",
        name: "E2E Checkout Flow",
        mcpServerId: "private-pw-uuid",
      })) as CreateTestSuiteResult;

      expect(result.suite.mcpServerId).toBe("private-pw-uuid");
    });

    it("rejects an explicit mcpServerId that is another user's private server", async () => {
      dbMock.$enqueue([
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
