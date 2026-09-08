import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTestCasesSchema,
  buildCreateTestCasesTool,
} from "@/lib/testing/tools/create-test-cases";
import type { CreateTestCasesResult } from "@/lib/testing/types";

vi.mock("@/lib/db", async () => {
  const { createDrizzleMock } = await import("tests/unit/helpers");
  return { db: createDrizzleMock() };
});

import { db } from "@/lib/db";
import type { MockDrizzleDb } from "tests/unit/helpers";

const dbMock = db as unknown as MockDrizzleDb;

describe("create_test_cases tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$reset();
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
      if (valid.success && valid.data.category === "evaluation") {
        expect(valid.data.cases[0]?.turns).toEqual([
          "Hello, what is your return policy?",
          "Can I return opened software?",
        ]);
      }
    });

    it("rejects category-inapplicable case fields", () => {
      // evaluation rejects toolName (verification-only field)
      expect(
        createTestCasesSchema.safeParse({
          category: "evaluation",
          suiteId: validUuid,
          cases: [{ name: "Case 1", turns: ["Hi"], toolName: "my_tool" }],
        }).success,
      ).toBe(false);

      // web-auto rejects turns (evaluation-only field)
      expect(
        createTestCasesSchema.safeParse({
          category: "web-auto",
          suiteId: validUuid,
          cases: [{ name: "Case 1", script: "await page.goto('/');", turns: ["Hi"] }],
        }).success,
      ).toBe(false);
    });

    it("accepts stringified JSON cases array and stringified assertions (LLM tolerance)", () => {
      const stringifiedCases = JSON.stringify([
        {
          name: "Stringified Web Case",
          script: "async (page) => { await page.goto('https://example.com'); }",
          steps: "1. Go to example.com",
          assertions: JSON.stringify([
            { type: "js_expression", expression: "result.success === true" },
          ]),
        },
      ]);

      const parsed = createTestCasesSchema.safeParse({
        category: "web-auto",
        suiteId: validUuid,
        cases: stringifiedCases,
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.cases).toHaveLength(1);
        expect(parsed.data.cases[0]?.name).toBe("Stringified Web Case");
        expect(parsed.data.cases[0]?.assertions).toEqual([
          { type: "js_expression", expression: "result.success === true" },
        ]);
      }
    });

    it("successfully parses the real-world user payloads from the bug report", () => {
      // User Attempt 1 & 2 payload
      const attempt1and2Cases =
        '[{"assertions": [{"expression": "result.success === true && result.count === 3", "type": "js_expression"}, {"expression": "result.topNews.every(n => typeof n.title === \'string\' && n.title.length > 0 && typeof n.url === \'string\' && n.url.indexOf(\'news.cnblogs.com/n/\') > 0)", "type": "js_expression"}, {"expected": 3, "operator": "==", "path": "$.topNews.length", "type": "jsonpath"}, {"operator": "exists", "path": "$.topNews[0].title", "type": "jsonpath"}, {"operator": "exists", "path": "$.topNews[2].url", "type": "jsonpath"}], "name": "博客园首页进入新闻板块并提取前三条新闻", "script": "async (page) => {\\n  await page.goto(\'https://www.cnblogs.com/\', { waitUntil: \'domcontentloaded\', timeout: 60000 });\\n\\n  const newsLink = page.locator(\'a[href*=\\"news.cnblogs.com\\"]\').filter({ hasText: \'新闻\' }).first();\\n  await newsLink.click();\\n  await page.waitForURL(/news\\\\.cnblogs\\\\.com/, { timeout: 30000 });\\n\\n  await page.waitForSelector(\'#news_list .news_block\', { timeout: 30000 });\\n\\n  const topNews = await page.$$eval(\'#news_list .news_block\', (blocks) =>\\n    blocks.slice(0, 3).map((block, i) => {\\n      const a = block.querySelector(\'h2 a\');\\n      return {\\n        rank: i + 1,\\n        title: a ? a.textContent.trim() : null,\\n        url: a ? a.href : null\\n      };\\n    })\\n  );\\n\\n  return {\\n    success: topNews.length === 3,\\n    newsPageUrl: page.url(),\\n    newsPageTitle: await page.title(),\\n    topNews,\\n    count: topNews.length\\n  };\\n}", "steps": "1. 打开博客园首页 https://www.cnblogs.com/；2. 点击顶部导航栏中的新闻链接，进入新闻板块 https://news.cnblogs.com/；3. 等待新闻列表（#news_list 下的 .news_block）加载完成；4. 提取前三条新闻的标题与详情链接；5. 返回结构化结果：success 标志、新闻页 URL 与标题、以及 topNews 数组（含 rank、title、url）。"}]';

      const res1 = createTestCasesSchema.safeParse({
        category: "web-auto",
        suiteId: "855eec71-a8a3-400b-bb9a-ba1f03955036",
        cases: attempt1and2Cases,
      });

      expect(res1.success).toBe(true);
      if (res1.success) {
        expect(res1.data.cases).toHaveLength(1);
        expect(res1.data.cases[0]?.name).toBe("博客园首页进入新闻板块并提取前三条新闻");
        expect(res1.data.cases[0]?.assertions).toHaveLength(5);
      }

      // User Attempt 3 diagnostic payload
      const attempt3Cases = '[{"name": "诊断用例-传输层测试"}]';
      const res3 = createTestCasesSchema.safeParse({
        category: "web-auto",
        suiteId: "855eec71-a8a3-400b-bb9a-ba1f03955036",
        cases: attempt3Cases,
      });

      expect(res3.success).toBe(true);
      if (res3.success) {
        expect(res3.data.cases).toHaveLength(1);
        expect(res3.data.cases[0]?.name).toBe("诊断用例-传输层测试");
      }
    });
  });

  describe("Tool Execution", () => {
    const ctx = { userId: "user-123", isAdmin: false, isEditor: true };
    const tool = buildCreateTestCasesTool(ctx);
    const testSuiteId = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";

    it("has tool name create_test_cases", () => {
      expect(tool.name).toBe("create_test_cases");
    });

    it("throws error when suite is not found", async () => {
      dbMock.$enqueue([]);

      await expect(
        tool.execute!({
          category: "verification",
          suiteId: testSuiteId,
          cases: [{ name: "Case 1", toolName: "test_tool" }],
        }),
      ).rejects.toThrow(/not found/);
    });

    it("creates verification cases in batch with enabled=false strictly enforced", async () => {
      dbMock.$enqueue(
        [
          {
            id: testSuiteId,
            mcpServerId: "server-uuid",
            visibility: "private",
            createdBy: "user-123",
          },
        ],
        [
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
        ],
      );

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
      expect(dbMock._chain.values).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ name: "Docs Search - Normal", enabled: false }),
          expect.objectContaining({ name: "Docs Search - Missing Keyword", enabled: false }),
        ]),
      );
    });

    it("creates evaluation cases and maps plain text turns to userMessage objects", async () => {
      dbMock.$enqueue(
        [
          {
            id: testSuiteId,
            visibility: "public",
            createdBy: "other-user",
          },
        ],
        [
          {
            id: 201,
            name: "Refund Policy Case",
            assertions: [
              { type: "metric", metric: "duration_s", operator: "<=", threshold: 10 },
            ],
          },
        ],
      );

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

      expect(dbMock._chain.values).toHaveBeenCalledWith(
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
      dbMock.$enqueue(
        [
          {
            id: testSuiteId,
            visibility: "private",
            createdBy: "user-123",
          },
        ],
        [
          {
            id: 301,
            name: "Checkout UI",
            assertions: [],
          },
        ],
      );

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
      expect(dbMock._chain.values).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            name: "Checkout UI",
            enabled: false,
            input: { script: "await page.goto('/checkout');", steps: "" },
          }),
        ]),
      );
    });

    it("creates web-auto cases when cases and assertions are passed as stringified JSON payloads", async () => {
      dbMock.$enqueue(
        [
          {
            id: testSuiteId,
            visibility: "private",
            createdBy: "user-123",
          },
        ],
        [
          {
            id: 302,
            name: "Stringified Web Case",
            assertions: [{ type: "js_expression", expression: "result.success === true" }],
          },
        ],
      );

      const stringifiedPayload = {
        category: "web-auto" as const,
        suiteId: testSuiteId,
        cases: JSON.stringify([
          {
            name: "Stringified Web Case",
            script: "async (page) => { await page.goto('/home'); }",
            steps: "1. Visit home",
            assertions: JSON.stringify([
              { type: "js_expression", expression: "result.success === true" },
            ]),
          },
        ]),
      };

      const parsedArgs = createTestCasesSchema.parse(stringifiedPayload);
      const result = (await tool.execute!(parsedArgs)) as CreateTestCasesResult;

      expect(result.category).toBe("web-auto");
      expect(result.createdCount).toBe(1);
      expect(result.cases[0]?.id).toBe(302);
      expect(result.cases[0]?.name).toBe("Stringified Web Case");
      expect(result.cases[0]?.assertionCount).toBe(1);

      expect(dbMock._chain.values).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            name: "Stringified Web Case",
            enabled: false,
            input: {
              script: "async (page) => { await page.goto('/home'); }",
              steps: "1. Visit home",
            },
          }),
        ]),
      );
    });

    it("handles unique violation by returning the conflicting case name", async () => {
      dbMock.$enqueue([
        {
          id: testSuiteId,
          mcpServerId: "server-1",
          visibility: "private",
          createdBy: "user-123",
        },
      ]);

      const uniqueError = new Error("duplicate key value violates unique constraint");
      (uniqueError as unknown as { code: string }).code = "23505";
      dbMock._chain.returning.mockRejectedValueOnce(uniqueError);

      dbMock.$enqueue([{ name: "Existing Case 1" }]);

      await expect(
        tool.execute!({
          category: "verification",
          suiteId: testSuiteId,
          cases: [
            { name: "Existing Case 1", toolName: "tool1" },
          ],
        }),
      ).rejects.toThrow(/duplicate case name\(s\) \['Existing Case 1'\] already exist/);
    });

    it("handles web-auto unique violation with friendly conflict message", async () => {
      dbMock.$enqueue([
        { id: testSuiteId, visibility: "private", createdBy: "user-123" },
      ]);

      const uniqueError = new Error("duplicate key value violates unique constraint");
      (uniqueError as unknown as { code: string }).code = "23505";
      dbMock._chain.returning.mockRejectedValueOnce(uniqueError);

      dbMock.$enqueue([{ name: "Existing UI Case" }]);

      await expect(
        tool.execute!({
          category: "web-auto",
          suiteId: testSuiteId,
          cases: [{ name: "Existing UI Case", script: "await page.goto('/');" }],
        }),
      ).rejects.toThrow(/duplicate case name\(s\) \['Existing UI Case'\] already exist/);
    });

    it("warns (non-blocking) when creating llm_judge cases under an evaluation suite with no evaluatorAgentId", async () => {
      dbMock.$enqueue(
        [
          {
            id: testSuiteId,
            visibility: "private",
            createdBy: "user-123",
            evaluatorAgentId: null,
          },
        ],
        [
          {
            id: 1,
            name: "Judge case",
            assertions: [{ type: "llm_judge", expectation: "clear answer" }],
          },
        ],
      );

      const result = (await tool.execute!({
        category: "evaluation",
        suiteId: testSuiteId,
        cases: [
          {
            name: "Judge case",
            turns: ["hello"],
            assertions: [{ type: "llm_judge", expectation: "clear answer" }],
          },
        ],
      })) as CreateTestCasesResult;

      expect(result.warnings).toBeDefined();
      expect(result.warnings?.[0]).toContain("no evaluatorAgentId");
    });

    it("warns (non-blocking) when creating llm_judge cases under a web-auto suite with no evaluatorAgentId", async () => {
      dbMock.$enqueue(
        [
          {
            id: testSuiteId,
            visibility: "private",
            createdBy: "user-123",
            evaluatorAgentId: null,
          },
        ],
        [
          {
            id: 2,
            name: "Visual check",
            assertions: [{ type: "llm_judge", expectation: "banner is visible" }],
          },
        ],
      );

      const result = (await tool.execute!({
        category: "web-auto",
        suiteId: testSuiteId,
        cases: [
          {
            name: "Visual check",
            script: "await page.goto('/');",
            assertions: [{ type: "llm_judge", expectation: "banner is visible" }],
          },
        ],
      })) as CreateTestCasesResult;

      expect(result.warnings).toBeDefined();
      expect(result.warnings?.[0]).toContain("no evaluatorAgentId");
    });
  });
});
