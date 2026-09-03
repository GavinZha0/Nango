import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTestCasesSchema,
  buildCreateTestCasesTool,
} from "@/lib/testing/tools/create-test-cases";
import type { CreateTestCasesResult } from "@/lib/testing/types";

// Mock db
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockReturning = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: (args: unknown) => mockSelect(args),
    insert: (table: unknown) => mockInsert(table),
  },
}));

describe("create_test_cases tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });
    mockLimit.mockResolvedValue([]);

    mockInsert.mockReturnValue({ values: mockValues });
    mockValues.mockReturnValue({ returning: mockReturning });
    mockReturning.mockResolvedValue([]);
  });

  describe("Schema Validation", () => {
    const validUuid = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";

    it("requires category, valid suiteId, and non-empty cases array", () => {
      const valid = createTestCasesSchema.safeParse({
        category: "verification",
        suiteId: validUuid,
        cases: [{ name: "Case 1", toolName: "my_tool" }],
      });
      expect(valid.success).toBe(true);

      const emptyCases = createTestCasesSchema.safeParse({
        category: "verification",
        suiteId: validUuid,
        cases: [],
      });
      expect(emptyCases.success).toBe(false);

      const missingSuiteId = createTestCasesSchema.safeParse({
        category: "verification",
        cases: [{ name: "Case 1" }],
      });
      expect(missingSuiteId.success).toBe(false);
    });

    it("accepts plain text turns for evaluation", () => {
      const valid = createTestCasesSchema.safeParse({
        category: "evaluation",
        suiteId: validUuid,
        cases: [
          {
            name: "Multi-turn inquiry",
            turns: ["Hello, what is your return policy?", "Can I return opened software?"],
          },
        ],
      });
      expect(valid.success).toBe(true);
      if (valid.success) {
        expect(valid.data.cases[0]?.turns).toEqual([
          "Hello, what is your return policy?",
          "Can I return opened software?",
        ]);
      }
    });
  });

  describe("Tool Execution", () => {
    const ctx = { userId: "user-123", isAdmin: false };
    const tool = buildCreateTestCasesTool(ctx);
    const testSuiteId = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";

    it("has tool name create_test_cases", () => {
      expect(tool.name).toBe("create_test_cases");
    });

    it("throws error when suite is not found or access denied", async () => {
      mockLimit.mockResolvedValueOnce([]);

      await expect(
        tool.execute!({
          category: "verification",
          suiteId: testSuiteId,
          cases: [{ name: "Case 1", toolName: "test_tool" }],
        }),
      ).rejects.toThrow(/not found or access denied/);
    });

    it("creates verification cases in batch with enabled=false strictly enforced", async () => {
      mockLimit.mockResolvedValueOnce([
        {
          id: testSuiteId,
          mcpServerId: "server-uuid",
          visibility: "private",
          createdBy: "user-123",
        },
      ]);

      mockReturning.mockResolvedValueOnce([
        {
          id: 101,
          name: "Docs Search - Normal",
          toolName: "microsoft_docs_search",
          assertions: [{ type: "js_expression", expression: "root.isError == false" }],
        },
        {
          id: 102,
          name: "Docs Search - Missing Keyword",
          toolName: "microsoft_docs_search",
          assertions: [],
        },
      ]);

      const result = (await tool.execute!({
        category: "verification",
        suiteId: testSuiteId,
        cases: [
          {
            name: "Docs Search - Normal",
            toolName: "microsoft_docs_search",
            input: { query: "Azure functions" },
            assertions: [{ type: "js_expression", expression: "root.isError == false" }],
          },
          {
            name: "Docs Search - Missing Keyword",
            toolName: "microsoft_docs_search",
            input: {},
            assertions: [],
          },
        ],
      })) as CreateTestCasesResult;

      expect(result.category).toBe("verification");
      expect(result.suiteId).toBe(testSuiteId);
      expect(result.createdCount).toBe(2);
      expect(result.cases[0]?.enabled).toBe(false);
      expect(result.cases[1]?.enabled).toBe(false);
      expect(result.cases[0]?.assertionCount).toBe(1);
      expect(result.cases[1]?.assertionCount).toBe(0);

      // Verify db.insert was called with enabled: false
      expect(mockValues).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ name: "Docs Search - Normal", enabled: false }),
          expect.objectContaining({ name: "Docs Search - Missing Keyword", enabled: false }),
        ]),
      );
    });

    it("creates evaluation cases and maps plain text turns to userMessage objects", async () => {
      mockLimit.mockResolvedValueOnce([
        {
          id: testSuiteId,
          visibility: "public",
          createdBy: "other-user",
        },
      ]);

      mockReturning.mockResolvedValueOnce([
        {
          id: 201,
          name: "Refund Policy Case",
          assertions: [
            { type: "metric", metric: "duration_s", operator: "<=", threshold: 10 },
          ],
        },
      ]);

      const result = (await tool.execute!({
        category: "evaluation",
        suiteId: testSuiteId,
        cases: [
          {
            name: "Refund Policy Case",
            turns: ["Can I get a refund?", "Where do I send the item?"],
            assertions: [
              { type: "metric", metric: "duration_s", operator: "<=", threshold: 10 },
            ],
          },
        ],
      })) as CreateTestCasesResult;

      expect(result.category).toBe("evaluation");
      expect(result.createdCount).toBe(1);
      expect(result.cases[0]?.id).toBe(201);
      expect(result.cases[0]?.enabled).toBe(false);

      expect(mockValues).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            name: "Refund Policy Case",
            enabled: false,
            input: {
              turns: [
                { userMessage: "Can I get a refund?" },
                { userMessage: "Where do I send the item?" },
              ],
            },
          }),
        ]),
      );
    });

    it("creates web-auto cases with enabled=false", async () => {
      mockLimit.mockResolvedValueOnce([
        {
          id: testSuiteId,
          visibility: "private",
          createdBy: "user-123",
        },
      ]);

      mockReturning.mockResolvedValueOnce([
        {
          id: 301,
          name: "Checkout UI",
          assertions: [],
        },
      ]);

      const result = (await tool.execute!({
        category: "web-auto",
        suiteId: testSuiteId,
        cases: [
          {
            name: "Checkout UI",
            script: "await page.goto('/checkout');",
            assertions: [],
          },
        ],
      })) as CreateTestCasesResult;

      expect(result.category).toBe("web-auto");
      expect(result.cases[0]?.enabled).toBe(false);
      expect(mockValues).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            name: "Checkout UI",
            enabled: false,
            input: { script: "await page.goto('/checkout');", steps: [] },
          }),
        ]),
      );
    });
  });
});
