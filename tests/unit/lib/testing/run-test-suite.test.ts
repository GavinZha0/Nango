import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runTestSuiteSchema,
  buildRunTestSuiteTool,
} from "@/lib/testing/tools/run-test-suite";
import type { RunTestSuiteResult } from "@/lib/testing/types";

// Mock db
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: (args: unknown) => mockSelect(args),
  },
}));

// Mock orchestrators
const mockStartSuiteRun = vi.fn();
vi.mock("@/lib/verification/run-orchestrator", () => ({
  startSuiteRun: (...args: unknown[]) => mockStartSuiteRun(...args),
}));

const mockStartEvalSuiteRun = vi.fn();
vi.mock("@/lib/evaluation/run-orchestrator", () => ({
  startEvalSuiteRun: (...args: unknown[]) => mockStartEvalSuiteRun(...args),
}));

const mockStartWebAutoSuiteRun = vi.fn();
vi.mock("@/lib/web-auto/orchestrator", () => ({
  startWebAutoSuiteRun: (...args: unknown[]) => mockStartWebAutoSuiteRun(...args),
}));

describe("run_test_suite tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });
    mockLimit.mockResolvedValue([]);
  });

  describe("Schema Validation", () => {
    const validUuid = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";

    it("requires category and valid suiteId UUID", () => {
      const valid = runTestSuiteSchema.safeParse({
        category: "verification",
        suiteId: validUuid,
      });
      expect(valid.success).toBe(true);

      const invalidUuid = runTestSuiteSchema.safeParse({
        category: "verification",
        suiteId: "not-a-uuid",
      });
      expect(invalidUuid.success).toBe(false);
    });
  });

  describe("Tool Execution", () => {
    const ctx = { userId: "user-123", isAdmin: false };
    const tool = buildRunTestSuiteTool(ctx);
    const validSuiteId = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";

    it("has tool name run_test_suite", () => {
      expect(tool.name).toBe("run_test_suite");
    });

    it("throws error when suite is not found or access denied", async () => {
      mockLimit.mockResolvedValueOnce([]);

      await expect(
        tool.execute!({
          category: "verification",
          suiteId: validSuiteId,
        }),
      ).rejects.toThrow(/not found or access denied/);
    });

    it("dispatches verification suite run", async () => {
      mockLimit.mockResolvedValueOnce([
        {
          id: validSuiteId,
          name: "MCP Verification Suite",
          visibility: "private",
          createdBy: "user-123",
        },
      ]);

      mockStartSuiteRun.mockResolvedValueOnce({
        runId: "run-ver-123",
        totalCount: 5,
      });

      const result = (await tool.execute!({
        category: "verification",
        suiteId: validSuiteId,
      })) as RunTestSuiteResult;

      expect(result.category).toBe("verification");
      expect(result.suiteId).toBe(validSuiteId);
      expect(result.suiteName).toBe("MCP Verification Suite");
      expect(result.runId).toBe("run-ver-123");
      expect(result.status).toBe("running");
      expect(result.totalCases).toBe(5);
      expect(mockStartSuiteRun).toHaveBeenCalledWith({
        suiteId: validSuiteId,
        ownerId: "user-123",
        triggeredBy: "manual",
      });
    });

    it("dispatches evaluation suite run", async () => {
      mockLimit.mockResolvedValueOnce([
        {
          id: validSuiteId,
          name: "Support Benchmark Suite",
          visibility: "public",
          createdBy: "other-user",
        },
      ]);

      mockStartEvalSuiteRun.mockResolvedValueOnce({
        runId: "run-eval-456",
        totalCount: 12,
      });

      const result = (await tool.execute!({
        category: "evaluation",
        suiteId: validSuiteId,
      })) as RunTestSuiteResult;

      expect(result.category).toBe("evaluation");
      expect(result.runId).toBe("run-eval-456");
      expect(result.totalCases).toBe(12);
      expect(mockStartEvalSuiteRun).toHaveBeenCalled();
    });

    it("dispatches web-auto suite run", async () => {
      mockLimit.mockResolvedValueOnce([
        {
          id: validSuiteId,
          name: "UI Smoke Tests",
          visibility: "private",
          createdBy: "user-123",
          mcpServerId: "playwright-server-uuid",
        },
      ]);

      mockStartWebAutoSuiteRun.mockResolvedValueOnce({
        runId: "run-web-789",
        totalCount: 3,
      });

      const result = (await tool.execute!({
        category: "web-auto",
        suiteId: validSuiteId,
      })) as RunTestSuiteResult;

      expect(result.category).toBe("web-auto");
      expect(result.runId).toBe("run-web-789");
      expect(result.totalCases).toBe(3);
      expect(mockStartWebAutoSuiteRun).toHaveBeenCalled();
    });

    it("rejects a web-auto suite run without a Playwright MCP server", async () => {
      mockLimit.mockResolvedValueOnce([
        {
          id: validSuiteId,
          name: "UI Smoke Tests",
          visibility: "private",
          createdBy: "user-123",
          mcpServerId: null,
        },
      ]);

      await expect(
        tool.execute!({
          category: "web-auto",
          suiteId: validSuiteId,
        }),
      ).rejects.toThrow(/has no Playwright MCP server configured/);

      expect(mockStartWebAutoSuiteRun).not.toHaveBeenCalled();
    });
  });
});
