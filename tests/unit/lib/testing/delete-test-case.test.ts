import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  deleteTestCaseSchema,
  buildDeleteTestCaseTool,
} from "@/lib/testing/tools/delete-test-case";
import type { DeleteTestCaseResult } from "@/lib/testing/types";

// Mock db
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockInnerJoin = vi.fn();
const mockWhereSelect = vi.fn();
const mockLimit = vi.fn();
const mockDelete = vi.fn();
const mockWhereDelete = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: (args: unknown) => mockSelect(args),
    delete: (table: unknown) => mockDelete(table),
  },
}));

describe("delete_test_case tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ innerJoin: mockInnerJoin });
    mockInnerJoin.mockReturnValue({ where: mockWhereSelect });
    mockWhereSelect.mockReturnValue({ limit: mockLimit });
    mockLimit.mockResolvedValue([]);

    mockDelete.mockReturnValue({ where: mockWhereDelete });
    mockWhereDelete.mockResolvedValue([]);
  });

  describe("Schema Validation", () => {
    it("requires category and positive integer caseId", () => {
      const valid = deleteTestCaseSchema.safeParse({
        category: "verification",
        caseId: 101,
      });
      expect(valid.success).toBe(true);

      const invalidCaseId = deleteTestCaseSchema.safeParse({
        category: "verification",
        caseId: 0,
      });
      expect(invalidCaseId.success).toBe(false);
    });
  });

  describe("Tool Execution", () => {
    const ctx = { userId: "user-123", isAdmin: false };
    const tool = buildDeleteTestCaseTool(ctx);

    it("has tool name delete_test_case", () => {
      expect(tool.name).toBe("delete_test_case");
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

    it("deletes verification case and returns caseName and suiteId", async () => {
      mockLimit.mockResolvedValueOnce([
        {
          caseRow: { id: 101, suiteId: "suite-ver-uuid", name: "Docs Search Case" },
          suite: { id: "suite-ver-uuid", visibility: "private", createdBy: "user-123" },
        },
      ]);

      const result = (await tool.execute!({
        category: "verification",
        caseId: 101,
      })) as DeleteTestCaseResult;

      expect(result.category).toBe("verification");
      expect(result.deleted).toBe(true);
      expect(result.caseId).toBe(101);
      expect(result.suiteId).toBe("suite-ver-uuid");
      expect(result.caseName).toBe("Docs Search Case");

      expect(mockDelete).toHaveBeenCalled();
    });

    it("deletes evaluation case and returns caseName", async () => {
      mockLimit.mockResolvedValueOnce([
        {
          caseRow: { id: 201, suiteId: "suite-eval-uuid", name: "Refund Case" },
          suite: { id: "suite-eval-uuid", visibility: "public", createdBy: "user-123" },
        },
      ]);

      const result = (await tool.execute!({
        category: "evaluation",
        caseId: 201,
      })) as DeleteTestCaseResult;

      expect(result.category).toBe("evaluation");
      expect(result.deleted).toBe(true);
      expect(result.caseId).toBe(201);
      expect(result.caseName).toBe("Refund Case");
    });

    it("deletes web-auto case and returns caseName", async () => {
      mockLimit.mockResolvedValueOnce([
        {
          caseRow: { id: 301, suiteId: "suite-web-uuid", name: "Checkout UI" },
          suite: { id: "suite-web-uuid", visibility: "private", createdBy: "user-123" },
        },
      ]);

      const result = (await tool.execute!({
        category: "web-auto",
        caseId: 301,
      })) as DeleteTestCaseResult;

      expect(result.category).toBe("web-auto");
      expect(result.deleted).toBe(true);
      expect(result.caseId).toBe(301);
      expect(result.caseName).toBe("Checkout UI");
    });
  });
});
