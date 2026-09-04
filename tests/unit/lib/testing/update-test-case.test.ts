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

    it("rejects category-inapplicable fields", () => {
      // verification rejects turns (evaluation-only field)
      expect(
        updateTestCaseSchema.safeParse({
          category: "verification",
          caseId: 101,
          turns: ["Hi"],
        }).success,
      ).toBe(false);

      // evaluation rejects toolName (verification-only field)
      expect(
        updateTestCaseSchema.safeParse({
          category: "evaluation",
          caseId: 101,
          toolName: "my_tool",
        }).success,
      ).toBe(false);
    });
  });

  describe("Tool Execution", () => {
    const ctx = { userId: "user-123", isAdmin: false, isEditor: true };
    const tool = buildUpdateTestCaseTool(ctx);

    it("has tool name update_test_case", () => {
      expect(tool.name).toBe("update_test_case");
    });

    it("requires at least one field to update", async () => {
      await expect(
        tool.execute!({
          category: "verification",
          caseId: 101,
        }),
      ).rejects.toThrow(/At least one field/);
    });

    it("throws error when case is not found", async () => {
      mockLimit.mockResolvedValueOnce([]);

      await expect(
        tool.execute!({
          category: "verification",
          caseId: 999,
          enabled: true,
        }),
      ).rejects.toThrow(/not found/);
    });

    it("rejects non-editor from editing cases in a suite", async () => {
      const nonEditorTool = buildUpdateTestCaseTool({ userId: "user-999", isEditor: false, isAdmin: false });
      mockLimit.mockResolvedValueOnce([
        {
          caseRow: { id: 101, suiteId: "suite-ver-uuid" },
          suite: { id: "suite-ver-uuid", visibility: "public", createdBy: "user-123" },
        },
      ]);

      await expect(
        nonEditorTool.execute!({
          category: "verification",
          caseId: 101,
          name: "Attempted edit",
        }),
      ).rejects.toThrow(/Permission denied: You do not have permission to edit cases in this suite/);
    });

    it("allows non-author editor to update a public suite case (collaborative editing)", async () => {
      mockLimit.mockResolvedValueOnce([
        {
          caseRow: { id: 101, suiteId: "suite-ver-uuid" },
          suite: { id: "suite-ver-uuid", visibility: "public", createdBy: "other-user" },
        },
      ]);

      mockReturning.mockResolvedValueOnce([
        {
          id: 101,
          suiteId: "suite-ver-uuid",
          name: "Public Case - Collaboratively Updated",
          enabled: true,
          assertions: [],
        },
      ]);

      const result = (await tool.execute!({
        category: "verification",
        caseId: 101,
        name: "Public Case - Collaboratively Updated",
      })) as UpdateTestCaseResult;

      expect(result.updated).toBe(true);
      expect(result.case.name).toBe("Public Case - Collaboratively Updated");
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
            input: { script: "old", steps: "" },
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
            steps: "",
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

    it("handles web-auto unique violation with friendly conflict message", async () => {
      mockLimit.mockResolvedValueOnce([
        {
          caseRow: { id: 301, suiteId: "suite-web-uuid" },
          suite: { id: "suite-web-uuid", visibility: "private", createdBy: "user-123" },
        },
      ]);

      const uniqueError = new Error("duplicate key value violates unique constraint");
      (uniqueError as unknown as { code: string }).code = "23505";
      mockReturning.mockRejectedValueOnce(uniqueError);

      await expect(
        tool.execute!({
          category: "web-auto",
          caseId: 301,
          name: "Duplicate UI Case",
        }),
      ).rejects.toThrow(
        /Failed to update web-auto case #301: a test case named 'Duplicate UI Case' already exists in this suite/,
      );
    });
  });
});
