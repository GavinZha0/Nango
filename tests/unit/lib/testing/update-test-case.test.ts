import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  updateTestCaseSchema,
  buildUpdateTestCaseTool,
} from "@/lib/testing/tools/update-test-case";
import type { UpdateTestCaseResult } from "@/lib/testing/types";

// Mock db
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockInnerJoin = vi.fn();
const mockWhereSelect = vi.fn();
const mockLimit = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockWhereUpdate = vi.fn();
const mockReturning = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: (args: unknown) => mockSelect(args),
    update: (table: unknown) => mockUpdate(table),
  },
}));

describe("update_test_case tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ innerJoin: mockInnerJoin });
    mockInnerJoin.mockReturnValue({ where: mockWhereSelect });
    mockWhereSelect.mockReturnValue({ limit: mockLimit });
    mockLimit.mockResolvedValue([]);

    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: mockWhereUpdate });
    mockWhereUpdate.mockReturnValue({ returning: mockReturning });
    mockReturning.mockResolvedValue([]);
  });

  describe("Schema Validation", () => {
    it("requires category and positive integer caseId", () => {
      const valid = updateTestCaseSchema.safeParse({
        category: "verification",
        caseId: 101,
        enabled: true,
      });
      expect(valid.success).toBe(true);

      const invalidCaseId = updateTestCaseSchema.safeParse({
        category: "verification",
        caseId: -1,
      });
      expect(invalidCaseId.success).toBe(false);
    });
  });

  describe("Tool Execution", () => {
    const ctx = { userId: "user-123", isAdmin: false };
    const tool = buildUpdateTestCaseTool(ctx);

    it("has tool name update_test_case", () => {
      expect(tool.name).toBe("update_test_case");
    });

    it("throws error when no fields to update are passed", async () => {
      await expect(
        tool.execute!({
          category: "verification",
          caseId: 101,
        }),
      ).rejects.toThrow(/At least one field/);
    });

    it("throws error when case is not found or access denied", async () => {
      mockLimit.mockResolvedValueOnce([]);

      await expect(
        tool.execute!({
          category: "verification",
          caseId: 999,
          enabled: true,
        }),
      ).rejects.toThrow(/not found or access denied/);
    });

    it("updates verification case with enabled=true and new assertions", async () => {
      mockLimit.mockResolvedValueOnce([
        {
          caseRow: { id: 101, suiteId: "suite-ver-uuid" },
          suite: { id: "suite-ver-uuid", visibility: "private", createdBy: "user-123" },
        },
      ]);

      mockReturning.mockResolvedValueOnce([
        {
          id: 101,
          suiteId: "suite-ver-uuid",
          name: "Docs Search - Updated",
          toolName: "microsoft_docs_search",
          enabled: true,
          input: { query: "Azure SDK" },
          assertions: [{ type: "js_expression", expression: "root.isError == false" }],
        },
      ]);

      const result = (await tool.execute!({
        category: "verification",
        caseId: 101,
        name: "Docs Search - Updated",
        enabled: true,
        assertions: [{ type: "js_expression", expression: "root.isError == false" }],
      })) as UpdateTestCaseResult;

      expect(result.category).toBe("verification");
      expect(result.updated).toBe(true);
      expect(result.case.id).toBe(101);
      expect(result.case.enabled).toBe(true);
      expect(result.case.name).toBe("Docs Search - Updated");
      expect(result.case.assertions).toHaveLength(1);

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Docs Search - Updated",
          enabled: true,
        }),
      );
    });

    it("updates evaluation case turns", async () => {
      mockLimit.mockResolvedValueOnce([
        {
          caseRow: { id: 201, suiteId: "suite-eval-uuid" },
          suite: { id: "suite-eval-uuid", visibility: "public", createdBy: "user-123" },
        },
      ]);

      mockReturning.mockResolvedValueOnce([
        {
          id: 201,
          suiteId: "suite-eval-uuid",
          name: "Refund Case",
          enabled: true,
          input: {
            turns: [{ userMessage: "Updated refund question" }],
          },
          assertions: [],
        },
      ]);

      const result = (await tool.execute!({
        category: "evaluation",
        caseId: 201,
        turns: ["Updated refund question"],
      })) as UpdateTestCaseResult;

      expect(result.category).toBe("evaluation");
      expect(result.updated).toBe(true);
      expect(result.case.turns).toEqual([{ userMessage: "Updated refund question" }]);
    });

    it("updates web-auto case script", async () => {
      mockLimit.mockResolvedValueOnce([
        {
          caseRow: {
            id: 301,
            suiteId: "suite-web-uuid",
            input: { script: "old", steps: [] },
          },
          suite: { id: "suite-web-uuid", visibility: "private", createdBy: "user-123" },
        },
      ]);

      mockReturning.mockResolvedValueOnce([
        {
          id: 301,
          suiteId: "suite-web-uuid",
          name: "Checkout UI",
          enabled: true,
          input: {
            script: "await page.goto('/checkout-v2');",
            steps: [],
          },
          assertions: [],
        },
      ]);

      const result = (await tool.execute!({
        category: "web-auto",
        caseId: 301,
        script: "await page.goto('/checkout-v2');",
      })) as UpdateTestCaseResult;

      expect(result.category).toBe("web-auto");
      expect(result.case.script).toBe("await page.goto('/checkout-v2');");
    });
  });
});
