import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runTestCaseSchema,
  buildRunTestCaseTool,
} from "@/lib/testing/tools/run-test-case";
import type { RunTestCaseResult } from "@/lib/testing/types";

// Mock db
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockInnerJoin = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: (args: unknown) => mockSelect(args),
  },
}));

// Mock runners
const mockRunMcpCase = vi.fn();
vi.mock("@/lib/verification/runner-mcp", () => ({
  runMcpCase: (...args: unknown[]) => mockRunMcpCase(...args),
}));

const mockRunEvalCase = vi.fn();
vi.mock("@/lib/evaluation/eval-runner", () => ({
  runEvalCase: (...args: unknown[]) => mockRunEvalCase(...args),
}));

const mockRunWebAutoCase = vi.fn();
vi.mock("@/lib/web-auto/orchestrator", () => ({
  runWebAutoCase: (...args: unknown[]) => mockRunWebAutoCase(...args),
}));

describe("run_test_case tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ innerJoin: mockInnerJoin });
    mockInnerJoin.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });
    mockLimit.mockResolvedValue([]);
  });

  describe("Schema Validation", () => {
    it("requires category and positive integer caseId", () => {
      const valid = runTestCaseSchema.safeParse({
        category: "verification",
        caseId: 101,
      });
      expect(valid.success).toBe(true);

      const invalidCaseId = runTestCaseSchema.safeParse({
        category: "verification",
        caseId: -1,
      });
      expect(invalidCaseId.success).toBe(false);
    });
  });

  describe("Tool Execution", () => {
    const ctx = { userId: "user-123", isAdmin: false };
    const tool = buildRunTestCaseTool(ctx);

    it("has tool name run_test_case", () => {
      expect(tool.name).toBe("run_test_case");
    });

    it("throws error when case is not found or access denied", async () => {
      mockLimit.mockResolvedValueOnce([]);

      await expect(
        tool.execute!({
          category: "verification",
          caseId: 999,
        }),
      ).rejects.toThrow(/not found or access denied/);
    });

    it("runs verification case and returns outcome with assertion results", async () => {
      mockLimit.mockResolvedValueOnce([
        {
          caseRow: {
            id: 101,
            name: "Search Tool Case",
            toolName: "docs_search",
            input: { query: "Azure" },
            assertions: [{ type: "js_expression", expression: "root.ok == true" }],
          },
          suite: {
            id: "suite-ver-uuid",
            mcpServerId: "server-uuid-1",
            visibility: "private",
            createdBy: "user-123",
          },
        },
      ]);

      mockRunMcpCase.mockResolvedValueOnce({
        status: "passed",
        durationMs: 320,
        assertionResults: [
          {
            type: "js_expression",
            ok: true,
          },
        ],
        error: null,
      });

      const result = (await tool.execute!({
        category: "verification",
        caseId: 101,
      })) as RunTestCaseResult;

      expect(result.category).toBe("verification");
      expect(result.caseId).toBe(101);
      expect(result.caseName).toBe("Search Tool Case");
      expect(result.status).toBe("passed");
      expect(result.durationMs).toBe(320);
      expect(result.assertionResults).toHaveLength(1);
      expect(result.assertionResults[0]?.passed).toBe(true);
      expect(result.error).toBeNull();
      expect(mockRunMcpCase).toHaveBeenCalled();
    });

    it("runs evaluation case and returns score, feedback, and assertions", async () => {
      mockLimit.mockResolvedValueOnce([
        {
          caseRow: {
            id: 201,
            name: "Refund Policy Case",
            input: { turns: ["How do I refund?"] },
            assertions: [],
          },
          suite: {
            id: "suite-eval-uuid",
            agentId: "agent-1",
            visibility: "public",
            createdBy: "user-123",
          },
        },
      ]);

      mockRunEvalCase.mockResolvedValueOnce({
        status: "passed",
        durationMs: 1200,
        score: 95,
        feedback: "Comprehensive and polite answer.",
        assertionResults: [],
        error: null,
      });

      const result = (await tool.execute!({
        category: "evaluation",
        caseId: 201,
      })) as RunTestCaseResult;

      expect(result.category).toBe("evaluation");
      expect(result.caseId).toBe(201);
      expect(result.status).toBe("passed");
      expect(result.score).toBe(95);
      expect(result.feedback).toBe("Comprehensive and polite answer.");
      expect(mockRunEvalCase).toHaveBeenCalled();
    });

    it("runs web-auto case and returns outcome", async () => {
      mockLimit.mockResolvedValueOnce([
        {
          caseRow: {
            id: 301,
            name: "Login UI Flow",
            input: { script: "await page.goto('/login');" },
            assertions: [],
          },
          suite: {
            id: "suite-web-uuid",
            mcpServerId: "playwright-server-uuid",
            visibility: "private",
            createdBy: "user-123",
          },
        },
      ]);

      mockRunWebAutoCase.mockResolvedValueOnce({
        status: "passed",
        durationMs: 2500,
        assertionResults: [],
        error: null,
      });

      const result = (await tool.execute!({
        category: "web-auto",
        caseId: 301,
      })) as RunTestCaseResult;

      expect(result.category).toBe("web-auto");
      expect(result.caseId).toBe(301);
      expect(result.status).toBe("passed");
      expect(result.durationMs).toBe(2500);
      expect(mockRunWebAutoCase).toHaveBeenCalled();
    });
  });
});
