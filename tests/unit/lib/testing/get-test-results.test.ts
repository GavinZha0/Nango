import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getTestResultsSchema,
  buildGetTestResultsTool,
} from "@/lib/testing/tools/get-test-results";
import type { GetTestResultsResult } from "@/lib/testing/types";

// Mock db
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockInnerJoin = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
const mockLimit = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: (args: unknown) => mockSelect(args),
  },
}));

describe("get_test_results tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({
      innerJoin: mockInnerJoin,
      where: mockWhere,
    });
    mockInnerJoin.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({
      orderBy: mockOrderBy,
      limit: mockLimit,
    });
    mockOrderBy.mockReturnValue({ limit: mockLimit });
    mockLimit.mockResolvedValue([]);
  });

  describe("Schema Validation", () => {
    const validUuid = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";

    it("accepts valid category with runId", () => {
      const valid = getTestResultsSchema.safeParse({
        category: "verification",
        runId: validUuid,
      });
      expect(valid.success).toBe(true);
    });

    it("accepts valid category with suiteId and last", () => {
      const valid = getTestResultsSchema.safeParse({
        category: "evaluation",
        suiteId: validUuid,
        last: 3,
        failedOnly: true,
      });
      expect(valid.success).toBe(true);
    });
  });

  describe("Tool Execution", () => {
    const ctx = { userId: "user-123", isAdmin: false };
    const tool = buildGetTestResultsTool(ctx);
    const validUuid = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";

    it("has tool name get_test_results", () => {
      expect(tool.name).toBe("get_test_results");
    });

    it("throws error when neither runId nor suiteId is provided", async () => {
      await expect(
        tool.execute!({
          category: "verification",
        }),
      ).rejects.toThrow(/Either 'runId' or 'suiteId'/);
    });

    it("retrieves verification results by runId with case assertion diagnostics", async () => {
      // 1. Run lookup with suite join
      mockLimit.mockResolvedValueOnce([
        {
          run: { id: validUuid, suiteId: "suite-ver-uuid" },
          suite: { id: "suite-ver-uuid", name: "Docs Suite" },
        },
      ]);

      // 2. Run query
      mockLimit.mockResolvedValueOnce([
        {
          id: validUuid,
          suiteId: "suite-ver-uuid",
          status: "passed",
          totalCount: 2,
          passedCount: 2,
          failedCount: 0,
          erroredCount: 0,
          startedAt: new Date("2026-09-02T10:00:00Z"),
          finishedAt: new Date("2026-09-02T10:00:05Z"),
        },
      ]);

      // 3. Case results query
      mockLimit.mockResolvedValueOnce([
        {
          result: {
            caseId: 101,
            status: "passed",
            durationMs: 250,
            assertionResults: [
              {
                type: "js_expression",
                ok: true,
                message: "JS Expression: root.ok == true",
              },
            ],
            error: null,
          },
          caseName: "Docs Search - Normal",
        },
      ]);

      const result = (await tool.execute!({
        category: "verification",
        runId: validUuid,
      })) as GetTestResultsResult;

      expect(result.category).toBe("verification");
      expect(result.suiteId).toBe("suite-ver-uuid");
      expect(result.suiteName).toBe("Docs Suite");
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0]?.summary.passed).toBe(2);
      expect(result.runs[0]?.summary.passRate).toBe(1);
      expect(result.runs[0]?.cases).toHaveLength(1);
      expect(result.runs[0]?.cases?.[0]?.caseName).toBe("Docs Search - Normal");
      expect(result.runs[0]?.cases?.[0]?.assertionResults[0]?.passed).toBe(true);
    });

    it("retrieves evaluation results by suiteId with last=3", async () => {
      // Suite lookup
      mockLimit.mockResolvedValueOnce([
        { id: validUuid, name: "Support Benchmark" },
      ]);

      // Runs query (3 runs)
      mockLimit.mockResolvedValueOnce([
        {
          id: "run-3",
          suiteId: validUuid,
          status: "passed",
          totalCount: 5,
          passedCount: 5,
          failedCount: 0,
          erroredCount: 0,
          score: 90,
          startedAt: new Date("2026-09-02T12:00:00Z"),
          finishedAt: new Date("2026-09-02T12:01:00Z"),
        },
        {
          id: "run-2",
          suiteId: validUuid,
          status: "failed",
          totalCount: 5,
          passedCount: 4,
          failedCount: 1,
          erroredCount: 0,
          score: 75,
          startedAt: new Date("2026-09-02T11:00:00Z"),
          finishedAt: new Date("2026-09-02T11:01:00Z"),
        },
        {
          id: "run-1",
          suiteId: validUuid,
          status: "failed",
          totalCount: 5,
          passedCount: 3,
          failedCount: 2,
          erroredCount: 0,
          score: 65,
          startedAt: new Date("2026-09-02T10:00:00Z"),
          finishedAt: new Date("2026-09-02T10:01:00Z"),
        },
      ]);

      const result = (await tool.execute!({
        category: "evaluation",
        suiteId: validUuid,
        last: 3,
      })) as GetTestResultsResult;

      expect(result.category).toBe("evaluation");
      expect(result.suiteName).toBe("Support Benchmark");
      expect(result.runs).toHaveLength(3);
      expect(result.runs[0]?.summary.averageScore).toBe(90);
      expect(result.runs[1]?.summary.averageScore).toBe(75);
      expect(result.runs[2]?.summary.averageScore).toBe(65);
    });

    it("filters cases with failedOnly=true", async () => {
      // Suite lookup
      mockLimit.mockResolvedValueOnce([
        { id: validUuid, name: "Web Smoke" },
      ]);

      // Single run
      mockLimit.mockResolvedValueOnce([
        {
          id: "web-run-1",
          suiteId: validUuid,
          status: "failed",
          passed: 1,
          failed: 1,
          errored: 0,
          startedAt: new Date("2026-09-02T10:00:00Z"),
          finishedAt: new Date("2026-09-02T10:00:30Z"),
        },
      ]);

      // Case results (1 passed, 1 failed)
      mockLimit.mockResolvedValueOnce([
        {
          result: {
            caseId: 301,
            status: "passed",
            durationMs: 1000,
            assertionResults: [],
            error: null,
          },
          caseName: "Login Case",
        },
        {
          result: {
            caseId: 302,
            status: "failed",
            durationMs: 1500,
            assertionResults: [
              {
                type: "js_expression",
                ok: false,
                message: "Expected page title to match",
              },
            ],
            error: { message: "Assertion failed" },
          },
          caseName: "Checkout Case",
        },
      ]);

      const result = (await tool.execute!({
        category: "web-auto",
        suiteId: validUuid,
        last: 1,
        failedOnly: true,
      })) as GetTestResultsResult;

      expect(result.runs[0]?.cases).toHaveLength(1);
      expect(result.runs[0]?.cases?.[0]?.caseId).toBe(302);
      expect(result.runs[0]?.cases?.[0]?.caseName).toBe("Checkout Case");
      expect(result.runs[0]?.cases?.[0]?.status).toBe("failed");
    });
  });
});
