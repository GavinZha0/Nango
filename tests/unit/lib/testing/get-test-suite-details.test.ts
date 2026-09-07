import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getTestSuiteDetailsSchema,
  buildGetTestSuiteDetailsTool,
} from "@/lib/testing/tools/get-test-suite-details";
import type { TestSuiteDetailsResult } from "@/lib/testing/types";

vi.mock("@/lib/db", async () => {
  const { createDrizzleMock } = await import("tests/unit/helpers");
  return { db: createDrizzleMock() };
});

import { db } from "@/lib/db";
import type { MockDrizzleDb } from "tests/unit/helpers";

const dbMock = db as unknown as MockDrizzleDb;

describe("get_test_suite_details tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$reset();
  });

  describe("Schema Validation", () => {
    const validUuid = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";

    it("requires category and valid suiteId UUID", () => {
      const valid = getTestSuiteDetailsSchema.safeParse({
        category: "verification",
        suiteId: validUuid,
      });
      expect(valid.success).toBe(true);

      const missingId = getTestSuiteDetailsSchema.safeParse({
        category: "verification",
      });
      expect(missingId.success).toBe(false);

      const invalidUuid = getTestSuiteDetailsSchema.safeParse({
        category: "verification",
        suiteId: "not-a-uuid",
      });
      expect(invalidUuid.success).toBe(false);

      const missingCategory = getTestSuiteDetailsSchema.safeParse({
        suiteId: validUuid,
      });
      expect(missingCategory.success).toBe(false);
    });
  });

  describe("Tool Execution", () => {
    const ctx = { userId: "user-123", isAdmin: false };
    const tool = buildGetTestSuiteDetailsTool(ctx);
    const testSuiteId = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";

    it("has tool name get_test_suite_details", () => {
      expect(tool.name).toBe("get_test_suite_details");
    });

    it("throws error when suite is not found", async () => {
      dbMock._chain.limit.mockResolvedValueOnce([]);

      await expect(
        tool.execute!({ category: "verification", suiteId: testSuiteId }),
      ).rejects.toThrow(/not found or access denied/);
    });

    it("returns suite details and lightweight case topology for verification", async () => {
      dbMock._chain.limit.mockResolvedValueOnce([
        {
          id: testSuiteId,
          name: "MCP Search Tools",
          description: "Search tools verification suite",
          mcpServerId: "mcp-server-1",
          serverName: "docs-mcp",
          caseCount: 2,
          enabled: true,
          visibility: "private",
        },
      ]);

      dbMock._chain.orderBy.mockResolvedValueOnce([
        {
          id: 101,
          name: "Search Docs",
          toolName: "microsoft_docs_search",
          enabled: true,
          assertions: [{ type: "js_expression", expression: "root.ok == true" }],
        },
        {
          id: 102,
          name: "Get Code Sample",
          toolName: "microsoft_docs_code",
          enabled: false,
          assertions: [
            { type: "js_expression", expression: "root.code.length > 0" },
            { type: "metric", metric: "duration_s", operator: "<=", threshold: 10 },
          ],
        },
      ]);

      const result = (await tool.execute!({
        category: "verification",
        suiteId: testSuiteId,
      })) as TestSuiteDetailsResult;

      expect(result.category).toBe("verification");
      expect(result.suite).toEqual({
        id: testSuiteId,
        name: "MCP Search Tools",
        description: "Search tools verification suite",
        mcpServerId: "mcp-server-1",
        serverName: "docs-mcp",
        caseCount: 2,
        enabled: true,
        visibility: "private",
      });

      expect(result.cases).toHaveLength(2);
      expect(result.cases[0]).toEqual({
        id: 101,
        name: "Search Docs",
        toolName: "microsoft_docs_search",
        enabled: true,
        assertionCount: 1,
      });
      expect(result.cases[1]).toEqual({
        id: 102,
        name: "Get Code Sample",
        toolName: "microsoft_docs_code",
        enabled: false,
        assertionCount: 2,
      });
    });

    it("returns suite details and cases for evaluation", async () => {
      dbMock._chain.limit.mockResolvedValueOnce([
        {
          id: testSuiteId,
          name: "Support Agent Eval",
          description: "Benchmark suite",
          agentId: "support-agent",
          agentSource: "builtin",
          evaluatorAgentId: "eval-gpt4o",
          caseCount: 1,
          enabled: true,
          visibility: "public",
        },
      ]);

      dbMock._chain.orderBy.mockResolvedValueOnce([
        {
          id: 201,
          name: "Greeting Case",
          enabled: true,
          assertions: [{ type: "expectation", expectation: "Polite greeting" }],
        },
      ]);

      const result = (await tool.execute!({
        category: "evaluation",
        suiteId: testSuiteId,
      })) as TestSuiteDetailsResult;

      expect(result.category).toBe("evaluation");
      expect(result.suite.agentId).toBe("support-agent");
      expect(result.cases[0]).toEqual({
        id: 201,
        name: "Greeting Case",
        enabled: true,
        assertionCount: 1,
      });
    });

    it("returns suite details and cases for web-auto", async () => {
      dbMock._chain.limit.mockResolvedValueOnce([
        {
          id: testSuiteId,
          name: "Checkout UI",
          description: "E2E checkout",
          mcpServerId: "playwright-service",
          timeoutSec: 300,
          caseCount: 1,
          enabled: false,
          visibility: "private",
        },
      ]);

      dbMock._chain.orderBy.mockResolvedValueOnce([
        {
          id: 301,
          name: "Submit Order Form",
          enabled: true,
          assertions: [],
        },
      ]);

      const result = (await tool.execute!({
        category: "web-auto",
        suiteId: testSuiteId,
      })) as TestSuiteDetailsResult;

      expect(result.category).toBe("web-auto");
      expect(result.suite.mcpServerId).toBe("playwright-service");
      expect(result.cases[0]).toEqual({
        id: 301,
        name: "Submit Order Form",
        enabled: true,
        assertionCount: 0,
      });
    });
  });
});
