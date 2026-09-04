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
    const ctx = { userId: "user-123", isAdmin: false, isEditor: true };
    const tool = buildDeleteTestCaseTool(ctx);

    it("has tool name delete_test_case", () => {
      expect(tool.name).toBe("delete_test_case");
    });

    it("throws error when case is not found", async () => {
      mockLimit.mockResolvedValueOnce([]);

      await expect(
        tool.execute!({
          category: "verification",
          caseId: 999,
        }),
      ).rejects.toThrow(/not found/);
    });

    it("rejects non-author editor from deleting a public suite case", async () => {
      mockLimit.mockResolvedValueOnce([
        {
          caseRow: { id: 101, suiteId: "suite-ver-uuid", name: "Public Shared Case" },
          suite: { id: "suite-ver-uuid", visibility: "public", createdBy: "other-user" },
        },
      ]);

      await expect(
        tool.execute!({
          category: "verification",
          caseId: 101,
        }),
      ).rejects.toThrow(/Permission denied: Only the suite author or an admin can delete cases/);
    });

    it("allows admin to delete cases created by other users in public suites", async () => {
      const adminTool = buildDeleteTestCaseTool({ userId: "admin-user", isAdmin: true, isEditor: true });
      mockLimit.mockResolvedValueOnce([
        {
          caseRow: { id: 101, suiteId: "suite-ver-uuid", name: "Public Shared Case" },
          suite: { id: "suite-ver-uuid", visibility: "public", createdBy: "other-user" },
        },
      ]);

      const result = (await adminTool.execute!({
        category: "verification",
        caseId: 101,
      })) as DeleteTestCaseResult;

      expect(result.deleted).toBe(true);
      expect(result.caseId).toBe(101);
    });

    it("deletes verification case and returns caseName and suiteId when author", async () => {
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

    it("deletes evaluation case and returns caseName when author", async () => {
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

    it("deletes web-auto case and returns caseName when author", async () => {
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

    it.each([
      ["verification", "suite-ver-uuid", 401],
      ["evaluation", "suite-eval-uuid", 402],
      ["web-auto", "suite-web-uuid", 403],
    ] as const)("deletes %s case identically (three-branch equivalence)", async (category, suiteId, caseId) => {
      mockLimit.mockResolvedValueOnce([
        {
          caseRow: { id: caseId, suiteId, name: "Shared Case" },
          suite: { id: suiteId, visibility: "private", createdBy: "user-123" },
        },
      ]);

      const result = (await tool.execute!({ category, caseId })) as DeleteTestCaseResult;

      expect(result.category).toBe(category);
      expect(result.deleted).toBe(true);
      expect(result.caseId).toBe(caseId);
      expect(result.suiteId).toBe(suiteId);
      expect(result.caseName).toBe("Shared Case");
      expect(mockDelete).toHaveBeenCalled();
    });
  });
});
