import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getTestCaseDetailsSchema,
  buildGetTestCaseDetailsTool,
} from "@/lib/testing/tools/get-test-case-details";
import type { TestCaseDetailsResult } from "@/lib/testing/types";

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

describe("get_test_case_details tool", () => {
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
      const valid = getTestCaseDetailsSchema.safeParse({
        category: "verification",
        caseId: 101,
      });
      expect(valid.success).toBe(true);

      const invalidCaseId = getTestCaseDetailsSchema.safeParse({
        category: "verification",
        caseId: -1,
      });
      expect(invalidCaseId.success).toBe(false);

      const missingCategory = getTestCaseDetailsSchema.safeParse({
        caseId: 101,
      });
      expect(missingCategory.success).toBe(false);
    });
  });

  describe("Tool Execution", () => {
    const ctx = { userId: "user-123", isAdmin: false };
    const tool = buildGetTestCaseDetailsTool(ctx);

    it("has tool name get_test_case_details", () => {
      expect(tool.name).toBe("get_test_case_details");
    });

    it("throws error when case is not found", async () => {
      mockLimit.mockResolvedValueOnce([]);

      await expect(
        tool.execute!({ category: "verification", caseId: 999 }),
      ).rejects.toThrow(/not found or access denied/);
    });

    it("returns case configuration for verification", async () => {
      mockLimit.mockResolvedValueOnce([
        {
          caseRow: {
            id: 101,
            suiteId: "suite-ver-uuid",
            name: "Search Azure Docs",
            toolName: "microsoft_docs_search",
            enabled: true,
            input: { query: "Azure storage" },
            assertions: [{ type: "js_expression", expression: "root.ok == true" }],
          },
          suite: {
            id: "suite-ver-uuid",
            visibility: "private",
            createdBy: "user-123",
          },
        },
      ]);

      const result = (await tool.execute!({
        category: "verification",
        caseId: 101,
      })) as TestCaseDetailsResult;

      expect(result.category).toBe("verification");
      expect(result.case).toEqual({
        id: 101,
        suiteId: "suite-ver-uuid",
        name: "Search Azure Docs",
        toolName: "microsoft_docs_search",
        enabled: true,
        input: { query: "Azure storage" },
        assertions: [{ type: "js_expression", expression: "root.ok == true" }],
      });
    });

    it("returns case configuration for evaluation", async () => {
      mockLimit.mockResolvedValueOnce([
        {
          caseRow: {
            id: 201,
            suiteId: "suite-eval-uuid",
            name: "Refund Policy Case",
            enabled: true,
            input: {
              turns: [{ role: "user", content: "How to refund?" }],
            },
            assertions: [{ type: "expectation", expectation: "Clear policy" }],
          },
          suite: {
            id: "suite-eval-uuid",
            visibility: "public",
            createdBy: "other-user",
          },
        },
      ]);

      const result = (await tool.execute!({
        category: "evaluation",
        caseId: 201,
      })) as TestCaseDetailsResult;

      expect(result.category).toBe("evaluation");
      expect(result.case.id).toBe(201);
      expect(result.case.turns).toEqual([{ role: "user", content: "How to refund?" }]);
      expect(result.case.assertions).toHaveLength(1);
    });

    it("returns case configuration for web-auto", async () => {
      mockLimit.mockResolvedValueOnce([
        {
          caseRow: {
            id: 301,
            suiteId: "suite-web-uuid",
            name: "Login Flow",
            enabled: false,
            input: {
              script: "await page.goto('/login');",
              steps: [{ action: "goto", url: "/login" }],
            },
            assertions: [{ type: "js_expression", expression: "page.url.includes('/login')" }],
          },
          suite: {
            id: "suite-web-uuid",
            visibility: "private",
            createdBy: "user-123",
          },
        },
      ]);

      const result = (await tool.execute!({
        category: "web-auto",
        caseId: 301,
      })) as TestCaseDetailsResult;

      expect(result.category).toBe("web-auto");
      expect(result.case.id).toBe(301);
      expect(result.case.script).toBe("await page.goto('/login');");
      expect(result.case.steps).toEqual([{ action: "goto", url: "/login" }]);
      expect(result.case.assertions).toHaveLength(1);
    });
  });
});
