import { describe, it, expect } from "vitest";

import {
  evaluateAssertions,
  normalizeTargetEnvelope,
  resolveInput,
  substituteInputTemplates,
  normalizeCaseName,
  validateAssertionSyntax,
  toolCallAssertionSchema,
  sanitizeAssertions,
  type AssertionSpec,
} from "@/lib/assertions";

describe("Universal Assertion Subsystem — evaluator engine", () => {
  describe("1. JSONPath assertions with multi-operators", () => {
    const payload = {
      user: {
        id: 101,
        name: "Alice",
        role: "admin",
        score: 95.5,
        tags: ["qa", "developer"],
        email: "alice@example.com",
      },
    };

    it("evaluates == and != operators", () => {
      const assertions: AssertionSpec[] = [
        { type: "jsonpath", path: "$.user.name", operator: "==", expected: "Alice" },
        { type: "jsonpath", path: "$.user.role", operator: "!=", expected: "guest" },
      ];
      const outcome = evaluateAssertions(payload, assertions);
      expect(outcome.allDeterministicPassed).toBe(true);
      expect(outcome.deterministicResults).toHaveLength(2);
      expect(outcome.deterministicResults[0].ok).toBe(true);
      expect(outcome.deterministicResults[1].ok).toBe(true);
    });

    it("evaluates comparison operators (>, >=, <, <=)", () => {
      const assertions: AssertionSpec[] = [
        { type: "jsonpath", path: "$.user.score", operator: ">", expected: 90 },
        { type: "jsonpath", path: "$.user.score", operator: ">=", expected: 95.5 },
        { type: "jsonpath", path: "$.user.score", operator: "<", expected: 100 },
        { type: "jsonpath", path: "$.user.score", operator: "<=", expected: 95.5 },
        // Failed case
        { type: "jsonpath", path: "$.user.score", operator: "<", expected: 50 },
      ];
      const outcome = evaluateAssertions(payload, assertions);
      expect(outcome.allDeterministicPassed).toBe(false);
      expect(outcome.deterministicResults[0].ok).toBe(true);
      expect(outcome.deterministicResults[1].ok).toBe(true);
      expect(outcome.deterministicResults[2].ok).toBe(true);
      expect(outcome.deterministicResults[3].ok).toBe(true);
      expect(outcome.deterministicResults[4].ok).toBe(false);
    });

    it("evaluates contains, matches, and exists operators", () => {
      const assertions: AssertionSpec[] = [
        { type: "jsonpath", path: "$.user.tags", operator: "contains", expected: "qa" },
        { type: "jsonpath", path: "$.user.email", operator: "matches", expected: "^[a-z]+@example\\.com$" },
        { type: "jsonpath", path: "$.user.id", operator: "exists" },
        { type: "jsonpath", path: "$.user.non_existent", operator: "exists" },
      ];
      const outcome = evaluateAssertions(payload, assertions);
      expect(outcome.deterministicResults[0].ok).toBe(true);
      expect(outcome.deterministicResults[1].ok).toBe(true);
      expect(outcome.deterministicResults[2].ok).toBe(true);
      expect(outcome.deterministicResults[3].ok).toBe(false);
    });

    it("evaluates wildcard [*] with every-element semantics and reports failed indices", () => {
      const collectionPayload = {
        items: [
          { id: 1, status: "active", price: 20 },
          { id: 2, status: "pending", price: 35 },
          { id: 3, status: "active", price: -5 },
        ],
        emptyItems: [],
      };

      // 1. All elements pass
      const allActive: AssertionSpec[] = [
        { type: "jsonpath", path: "items[*].price", operator: "!=", expected: 0 },
      ];
      const outcomePass = evaluateAssertions(collectionPayload, allActive);
      expect(outcomePass.allDeterministicPassed).toBe(true);
      expect(outcomePass.deterministicResults[0].ok).toBe(true);

      // 2. Single element failure: item 1 is "pending", not "active"
      const allEqual: AssertionSpec[] = [
        { type: "jsonpath", path: "items[*].status", operator: "==", expected: "active" },
      ];
      const outcomeFail = evaluateAssertions(collectionPayload, allEqual);
      expect(outcomeFail.allDeterministicPassed).toBe(false);
      expect(outcomeFail.deterministicResults[0].ok).toBe(false);
      expect(outcomeFail.deterministicResults[0].actual).toEqual([1]);
      expect(outcomeFail.deterministicResults[0].message).toBe("unsatisfied item(s): [1]");

      // 3. Price > 0 fails for item 2 (-5)
      const pricePositive: AssertionSpec[] = [
        { type: "jsonpath", path: "items[*].price", operator: ">", expected: 0 },
      ];
      const outcomePrice = evaluateAssertions(collectionPayload, pricePositive);
      expect(outcomePrice.allDeterministicPassed).toBe(false);
      expect(outcomePrice.deterministicResults[0].actual).toEqual([2]);

      // 4. Empty items list
      const emptyCheck: AssertionSpec[] = [
        { type: "jsonpath", path: "emptyItems[*].id", operator: "==", expected: 1 },
      ];
      const outcomeEmpty = evaluateAssertions(collectionPayload, emptyCheck);
      expect(outcomeEmpty.allDeterministicPassed).toBe(false);
      expect(outcomeEmpty.deterministicResults[0].message).toContain("matched 0 items");

      // 5. Missing leaf fields do not shift original array indices (P1-1)
      const missingFieldPayload = {
        items: [
          { status: "active" }, // index 0: passes
          { other: 1 },          // index 1: missing status -> fails
          { status: "pending" }, // index 2: pending != active -> fails
        ],
      };
      const missingFieldCheck: AssertionSpec[] = [
        { type: "jsonpath", path: "items[*].status", operator: "==", expected: "active" },
      ];
      const outcomeMissing = evaluateAssertions(missingFieldPayload, missingFieldCheck);
      expect(outcomeMissing.allDeterministicPassed).toBe(false);
      expect(outcomeMissing.deterministicResults[0].ok).toBe(false);
      expect(outcomeMissing.deterministicResults[0].actual).toEqual([1, 2]);
      expect(outcomeMissing.deterministicResults[0].message).toBe("unsatisfied item(s): [1, 2]");

      // 6. Wildcard [*] with exists operator enforces every-element existence (P2-3)
      const existsPayload = {
        items: [
          { id: 1, name: "Alice" },
          { id: 2 }, // missing 'name'
          { id: 3, name: "Charlie" },
        ],
      };
      const existsCheck: AssertionSpec[] = [
        { type: "jsonpath", path: "items[*].name", operator: "exists" },
      ];
      const outcomeExists = evaluateAssertions(existsPayload, existsCheck);
      expect(outcomeExists.allDeterministicPassed).toBe(false);
      expect(outcomeExists.deterministicResults[0].ok).toBe(false);
      expect(outcomeExists.deterministicResults[0].actual).toEqual([1]);
      expect(outcomeExists.deterministicResults[0].message).toBe("unsatisfied item(s): [1]");

      const allExistPayload = {
        items: [
          { id: 1, name: "Alice" },
          { id: 2, name: "Bob" },
        ],
      };
      const outcomeAllExist = evaluateAssertions(allExistPayload, existsCheck);
      expect(outcomeAllExist.allDeterministicPassed).toBe(true);
      expect(outcomeAllExist.deterministicResults[0].ok).toBe(true);
    });
  });

  describe("2. JSON Schema assertions", () => {
    it("validates structural schema correctly", () => {
      const payload = {
        name: "Test Order",
        amount: 49.99,
        items: [{ id: "item-1", qty: 2 }],
      };

      const validSchema: AssertionSpec = {
        type: "json_schema",
        schema: {
          type: "object",
          required: ["name", "amount", "items"],
          properties: {
            amount: { type: "number", minimum: 0 },
            items: { type: "array", minItems: 1 },
          },
        },
      };

      const invalidSchema: AssertionSpec = {
        type: "json_schema",
        schema: {
          type: "object",
          required: ["missing_field"],
        },
      };

      const outcome = evaluateAssertions(payload, [validSchema, invalidSchema]);
      expect(outcome.deterministicResults[0].ok).toBe(true);
      expect(outcome.deterministicResults[1].ok).toBe(false);
      expect(outcome.deterministicResults[1].message).toContain("missing_field");
    });

    it("handles schemas with $id repeatedly without global Ajv collision", () => {
      const payload = { code: 200, status: "ok" };
      const schemaWithId = (id: string): AssertionSpec => ({
        type: "json_schema",
        schema: {
          $id: id,
          type: "object",
          required: ["code", "status"],
          properties: {
            code: { type: "number" },
            status: { type: "string" },
          },
        },
      });

      // Repeat evaluation with newly deserialized schema objects having the same $id
      const schemaA = JSON.parse(
        JSON.stringify(schemaWithId("https://example.com/status-schema.json")),
      );
      const schemaB = JSON.parse(
        JSON.stringify(schemaWithId("https://example.com/status-schema.json")),
      );

      const outcome1 = evaluateAssertions(payload, [schemaA]);
      expect(outcome1.allDeterministicPassed).toBe(true);

      const outcome2 = evaluateAssertions(payload, [schemaB]);
      expect(outcome2.allDeterministicPassed).toBe(true);
      expect(outcome2.deterministicResults[0].errored).toBeUndefined();

      // Schemas with nested definitions having $id
      const nestedSchema: AssertionSpec = {
        type: "json_schema",
        schema: {
          type: "object",
          $defs: {
            item: {
              $id: "https://example.com/nested-item.json",
              type: "number",
            },
          },
          properties: {
            code: { $ref: "https://example.com/nested-item.json" },
          },
        },
      };
      const nestedA = JSON.parse(JSON.stringify(nestedSchema));
      const nestedB = JSON.parse(JSON.stringify(nestedSchema));
      const resNested1 = evaluateAssertions(payload, [nestedA]);
      expect(resNested1.allDeterministicPassed).toBe(true);
      const resNested2 = evaluateAssertions(payload, [nestedB]);
      expect(resNested2.allDeterministicPassed).toBe(true);
    });
  });

  describe("3. JS Expression assertions", () => {
    it("evaluates sandboxed expressions with input, variables, and runContext", () => {
      const payload = {
        records: [10, 20, 30],
        meta: { total: 60 },
      };

      const assertions: AssertionSpec[] = [
        { type: "js_expression", expression: "result.records.reduce((a, b) => a + b, 0) === result.meta.total" },
        { type: "js_expression", expression: "input.threshold === 50 && variables.env === 'staging'" },
        { type: "js_expression", expression: "result.records.length > 5" },
      ];

      const outcome = evaluateAssertions(payload, assertions, {
        input: { threshold: 50 },
        variables: { env: "staging" },
      });
      expect(outcome.deterministicResults[0].ok).toBe(true);
      expect(outcome.deterministicResults[1].ok).toBe(true);
      expect(outcome.deterministicResults[2].ok).toBe(false);
    });


    it("never exposes the _page handle to js_expression", () => {
      const payload = { result: { status: "ok", count: 5 }, _page: { evaluate: () => "host-secret" } };
      const assertions: AssertionSpec[] = [
        { type: "js_expression", expression: "result.count === 5" },
        { type: "js_expression", expression: "typeof _page !== 'undefined'" },
      ];
      const outcome = evaluateAssertions(payload, assertions);
      expect(outcome.deterministicResults[0].ok).toBe(true);
      expect(outcome.deterministicResults[1].ok).toBe(false);
    });


  });

  describe("4. Tool Call Trajectory assertions", () => {
    const options = {
      toolCalls: [
        { name: "search_knowledge_base", args: { query: "refund policy", limit: 5 } },
        { name: "send_email", args: { to: "customer@example.com", subject: "Refund Status" } },
      ],
    };

    it("verifies expected tool calls and arguments", () => {
      const assertions: AssertionSpec[] = [
        {
          type: "tool_call",
          toolName: "search_knowledge_base",
          operator: "==",
          expectedCalls: 1,
          expectedArgs: { query: "refund policy" },
        },
        {
          type: "tool_call",
          toolName: "delete_database",
          operator: "==",
          expectedCalls: 0, // forbidden
        },
        {
          type: "tool_call",
          toolName: "charge_credit_card",
          operator: "==",
          expectedCalls: 1, // missing tool call
        },
      ];

      const outcome = evaluateAssertions({}, assertions, options);
      expect(outcome.deterministicResults[0].ok).toBe(true);
      expect(outcome.deterministicResults[1].ok).toBe(true);
      expect(outcome.deterministicResults[2].ok).toBe(false);
    });

    it("evaluates operators (<, >, ==) with toolCallSummary for calls, failed, and blocked targets", () => {
      const toolCallSummary = {
        totalCalls: 5,
        failureCount: 1,
        blockedCount: 2,
        toolFrequency: {
          run_ssh_command: 3,
          read_file: 2,
        },
        abnormalDetails: [
          { toolName: "read_file", status: "failed" as const, reason: "File not found" },
          { toolName: "run_ssh_command", status: "blocked" as const, code: "POLICY_DENIED", reason: "Headless execution denied by policy" },
          { toolName: "run_ssh_command", status: "blocked" as const, code: "POLICY_DENIED", reason: "Headless execution denied by policy" },
        ],
      };

      const assertions: AssertionSpec[] = [
        // 1. calls < 4 for run_ssh_command (actual is 3 -> passes)
        {
          type: "tool_call",
          toolName: "run_ssh_command",
          operator: "<",
          target: "calls",
          expectedCalls: 4,
        },
        // 2. calls < 3 for run_ssh_command (actual is 3 -> fails)
        {
          type: "tool_call",
          toolName: "run_ssh_command",
          operator: "<",
          target: "calls",
          expectedCalls: 3,
        },
        // 3. calls == 2 for read_file (actual is 2 -> passes)
        {
          type: "tool_call",
          toolName: "read_file",
          operator: "==",
          target: "calls",
          expectedCalls: 2,
        },
        // 4. calls > 1 for read_file (actual is 2 -> passes)
        {
          type: "tool_call",
          toolName: "read_file",
          operator: ">",
          target: "calls",
          expectedCalls: 1,
        },
        // 5. read_file failed == 1 (actual is 1 -> passes)
        {
          type: "tool_call",
          toolName: "read_file",
          operator: "==",
          target: "failed",
          expectedCalls: 1,
        },
        // 6. read_file failed < 1 (actual is 1 -> fails)
        {
          type: "tool_call",
          toolName: "read_file",
          operator: "<",
          target: "failed",
          expectedCalls: 1,
        },
        // 7. run_ssh_command failed == 0 (actual is 0 -> passes)
        {
          type: "tool_call",
          toolName: "run_ssh_command",
          operator: "==",
          target: "failed",
          expectedCalls: 0,
        },
        // 8. run_ssh_command blocked == 2 (actual is 2 -> passes)
        {
          type: "tool_call",
          toolName: "run_ssh_command",
          operator: "==",
          target: "blocked",
          expectedCalls: 2,
        },
        // 9. run_ssh_command blocked < 3 (actual is 2 -> passes)
        {
          type: "tool_call",
          toolName: "run_ssh_command",
          operator: "<",
          target: "blocked",
          expectedCalls: 3,
        },
        // 10. run_ssh_command blocked == 0 (actual is 2 -> fails)
        {
          type: "tool_call",
          toolName: "run_ssh_command",
          operator: "==",
          target: "blocked",
          expectedCalls: 0,
        },
      ];

      const outcome = evaluateAssertions({}, assertions, { toolCallSummary });
      const results = outcome.deterministicResults;

      expect(results[0].ok).toBe(true);  // run_ssh_command calls < 4 (3 < 4)
      expect(results[1].ok).toBe(false); // run_ssh_command calls < 3 (3 < 3)
      expect(results[1].actual).toBe(3);
      expect(results[2].ok).toBe(true);  // read_file calls == 2 (2 == 2)
      expect(results[3].ok).toBe(true);  // read_file calls > 1 (2 > 1)
      expect(results[4].ok).toBe(true);  // read_file failed == 1 (1 == 1)
      expect(results[5].ok).toBe(false); // read_file failed < 1 (1 < 1 is false)
      expect(results[5].actual).toBe(1);
      expect(results[6].ok).toBe(true);  // run_ssh_command failed == 0 (0 == 0)
      expect(results[7].ok).toBe(true);  // run_ssh_command blocked == 2 (2 == 2)
      expect(results[8].ok).toBe(true);  // run_ssh_command blocked < 3 (2 < 3)
      expect(results[9].ok).toBe(false); // run_ssh_command blocked == 0 (2 == 0)
      expect(results[9].actual).toBe(2);
    });

    it("handles toolCallSummary with missing or undefined toolFrequency safely without throwing", () => {
      const toolCallSummary = {
        totalCalls: 0,
        failureCount: 0,
        blockedCount: 0,
      };

      const assertions: AssertionSpec[] = [
        {
          type: "tool_call",
          toolName: "run_ssh_command",
          operator: "==",
          target: "calls",
          expectedCalls: 0,
        },
      ];

      const outcome = evaluateAssertions({}, assertions, { toolCallSummary });
      expect(outcome.deterministicResults[0].ok).toBe(true);
    });

    it("requires operator in toolCallAssertionSchema and rejects when omitted", () => {
      const valid = toolCallAssertionSchema.safeParse({
        type: "tool_call",
        toolName: "read_file",
        operator: "<",
        expectedCalls: 2,
      });
      expect(valid.success).toBe(true);

      const missingOp = toolCallAssertionSchema.safeParse({
        type: "tool_call",
        toolName: "read_file",
        expectedCalls: 2,
      });
      expect(missingOp.success).toBe(false);
      expect(missingOp.error?.issues[0]?.path).toContain("operator");
    });

    it("sets errored: true when evaluating target 'failed' or 'blocked' without toolCallSummary", () => {
      const assertions: AssertionSpec[] = [
        {
          type: "tool_call",
          toolName: "read_file",
          operator: "<",
          target: "failed",
          expectedCalls: 1,
        },
        {
          type: "tool_call",
          toolName: "run_ssh_command",
          operator: "==",
          target: "blocked",
          expectedCalls: 0,
        },
      ];

      // No toolCallSummary provided in options
      const outcome = evaluateAssertions({}, assertions, {});
      expect(outcome.allDeterministicPassed).toBe(false);
      expect(outcome.deterministicResults[0].errored).toBe(true);
      expect(outcome.deterministicResults[0].errorSource).toBe("config");
      expect(outcome.deterministicResults[0].message).toContain("requires toolCallSummary");
      expect(outcome.deterministicResults[1].errored).toBe(true);
      expect(outcome.deterministicResults[1].errorSource).toBe("config");
      expect(outcome.deterministicResults[1].message).toContain("requires toolCallSummary");
    });

    it("marks tool_call with empty toolName as errored config error", () => {
      const assertions: AssertionSpec[] = [
        {
          type: "tool_call",
          toolName: "",
          operator: "<",
          target: "calls",
          expectedCalls: 3,
        },
        {
          type: "tool_call",
          toolName: "   ",
          operator: ">",
          target: "calls",
          expectedCalls: 0,
        },
      ];

      const outcome = evaluateAssertions({}, assertions, { actualToolCallNames: ["calculator"] });
      expect(outcome.allDeterministicPassed).toBe(false);
      expect(outcome.deterministicResults[0].errored).toBe(true);
      expect(outcome.deterministicResults[0].errorSource).toBe("config");
      expect(outcome.deterministicResults[0].message).toContain("missing required toolName");
      expect(outcome.deterministicResults[1].errored).toBe(true);
      expect(outcome.deterministicResults[1].errorSource).toBe("config");
    });

    it("sanitizeAssertions strips tool_call with empty or whitespace toolName while preserving valid assertions", () => {
      const assertions = [
        { type: "tool_call", toolName: "", target: "calls", operator: "<", expectedCalls: 3 },
        { type: "tool_call", toolName: "   ", target: "calls", operator: "==", expectedCalls: 1 },
        { type: "tool_call", toolName: "find", target: "calls", operator: ">", expectedCalls: 3 },
        { type: "metric", metric: "duration_s", operator: "<", threshold: 10 },
        { type: "js_expression", expression: "result.ok === true" },
      ];

      const sanitized = sanitizeAssertions(assertions as AssertionSpec[]);
      expect(sanitized).toHaveLength(3);
      expect(sanitized[0]).toMatchObject({ type: "tool_call", toolName: "find" });
      expect(sanitized[1]).toMatchObject({ type: "metric", metric: "duration_s" });
      expect(sanitized[2]).toMatchObject({ type: "js_expression", expression: "result.ok === true" });
    });
  });

  describe("5. Metric assertions", () => {
    const options = {
      metrics: {
        durationMs: 3200,
        outputChars: 450,
        toolCallCount: 2,
      },
    };

    it("evaluates performance and resource metrics", () => {
      const assertions: AssertionSpec[] = [
        { type: "metric", metric: "duration_s", operator: "<", threshold: 5 },
        { type: "metric", metric: "output_chars", operator: "<", threshold: 1000 },
        { type: "metric", metric: "total_tool_calls", operator: "==", threshold: 2 },
        // Failed rule: 3.2s < 2s is false
        { type: "metric", metric: "duration_s", operator: "<", threshold: 2 },
      ];

      const outcome = evaluateAssertions({}, assertions, options);
      expect(outcome.deterministicResults[0].ok).toBe(true);
      expect(outcome.deterministicResults[0].actual).toBe(3.2);
      expect(outcome.deterministicResults[1].ok).toBe(true);
      expect(outcome.deterministicResults[2].ok).toBe(true);
      expect(outcome.deterministicResults[3].ok).toBe(false);
      expect(outcome.deterministicResults[3].actual).toBe(3.2);
    });

    it("evaluates tool_failures and tool_blocked metrics with operators (<, >, ==)", () => {
      const toolCallSummary = {
        totalCalls: 5,
        failureCount: 1,
        blockedCount: 2,
        toolFrequency: {
          run_ssh_command: 3,
          read_file: 2,
        },
        abnormalDetails: [
          { toolName: "read_file", status: "failed" as const, reason: "File not found" },
          { toolName: "run_ssh_command", status: "blocked" as const, code: "POLICY_DENIED", reason: "Headless execution denied by policy" },
          { toolName: "run_ssh_command", status: "blocked" as const, code: "POLICY_DENIED", reason: "Headless execution denied by policy" },
        ],
      };

      const assertions: AssertionSpec[] = [
        { type: "metric", metric: "tool_failures", operator: "<", threshold: 2 },
        { type: "metric", metric: "tool_failures", operator: "==", threshold: 1 },
        { type: "metric", metric: "tool_failures", operator: ">", threshold: 0 },
        { type: "metric", metric: "tool_blocked", operator: "<", threshold: 3 },
        { type: "metric", metric: "tool_blocked", operator: "==", threshold: 2 },
        { type: "metric", metric: "tool_blocked", operator: "==", threshold: 0 },
      ];

      const outcome = evaluateAssertions({}, assertions, { toolCallSummary });
      const results = outcome.deterministicResults;
      expect(results[0].ok).toBe(true);  // 1 < 2
      expect(results[1].ok).toBe(true);  // 1 == 1
      expect(results[2].ok).toBe(true);  // 1 > 0
      expect(results[3].ok).toBe(true);  // 2 < 3
      expect(results[4].ok).toBe(true);  // 2 == 2
      expect(results[5].ok).toBe(false); // 2 == 0
    });

    it("sets errored: true on tool_failures and tool_blocked metrics when toolCallSummary is missing", () => {
      const assertions: AssertionSpec[] = [
        { type: "metric", metric: "tool_failures", operator: "<", threshold: 1 },
        { type: "metric", metric: "tool_blocked", operator: "==", threshold: 0 },
      ];

      // No toolCallSummary passed
      const outcome = evaluateAssertions({}, assertions, {});
      expect(outcome.allDeterministicPassed).toBe(false);
      expect(outcome.deterministicResults[0].errored).toBe(true);
      expect(outcome.deterministicResults[0].errorSource).toBe("config");
      expect(outcome.deterministicResults[0].message).toContain("was not recorded for this execution");
      expect(outcome.deterministicResults[1].errored).toBe(true);
      expect(outcome.deterministicResults[1].errorSource).toBe("config");
      expect(outcome.deterministicResults[1].message).toContain("was not recorded for this execution");
    });
  });

  describe("6. LLM dim and custom partitioning", () => {
    it("partitions LLM assertions for Tier 2 evaluation", () => {
      const assertions: AssertionSpec[] = [
        { type: "jsonpath", path: "$.status", operator: "==", expected: "ok" },
        { type: "llm_custom", expectation: "Assistant should explain the policy politely", reference: "Refunds take 3 days." },
        { type: "llm_dim", dim: "politeness" },
      ];

      const outcome = evaluateAssertions({ status: "ok" }, assertions);
      expect(outcome.deterministicResults).toHaveLength(1);
      expect(outcome.deterministicResults[0].ok).toBe(true);
      expect(outcome.llmAssertions).toHaveLength(2);
      expect((outcome.llmAssertions[0].spec as import("@/lib/assertions").LlmCustomAssertion).expectation).toBe("Assistant should explain the policy politely");
      expect(outcome.allDeterministicPassed).toBe(true);
    });
  });

  describe("7. Dynamic variable resolution & template substitution", () => {
    it("resolves dynamic generator tokens ($uuid, $timestamp, $randomString, $int)", () => {
      const rawInput = {
        userId: "{{$uuid}}",
        time: "{{$timestamp}}",
        nonce: "{{$randomString(10)}}",
        score: "{{$int(10, 20)}}",
        nested: {
          id: "{{$uuidv7}}",
        },
      };

      const resolved = resolveInput(rawInput);
      expect(typeof resolved.userId).toBe("string");
      expect((resolved.userId as string).length).toBe(36);
      expect(typeof resolved.time).toBe("number");
      expect(typeof resolved.nonce).toBe("string");
      expect((resolved.nonce as string).length).toBe(10);
      expect(typeof resolved.score).toBe("number");
      expect(resolved.score as number).toBeGreaterThanOrEqual(10);
      expect(resolved.score as number).toBeLessThanOrEqual(20);
    });

    it("substitutes input references in assertions against execution output", () => {
      const payload = {
        status: "created",
        data: {
          requestId: "req-999",
          owner: "Alice",
        },
      };

      const assertions: AssertionSpec[] = [
        {
          type: "jsonpath",
          path: "$.data.requestId",
          operator: "==",
          expected: "{{input.expectedRequestId}}",
        },
        {
          type: "jsonpath",
          path: "$.data.owner",
          operator: "==",
          expected: "{{variables.ownerName}}",
        },
      ];

      const outcome = evaluateAssertions(payload, assertions, {
        input: { expectedRequestId: "req-999" },
        variables: { ownerName: "Alice" },
      });

      expect(outcome.allDeterministicPassed).toBe(true);
      expect(outcome.deterministicResults[0].ok).toBe(true);
      expect(outcome.deterministicResults[1].ok).toBe(true);
    });

    it("directly substitutes input and variable templates", () => {
      const template = { greeting: "Hello {{input.name}}", url: "{{variables.host}}/api" };
      const substituted = substituteInputTemplates(template, { name: "Bob" }, { host: "https://example.com" }) as typeof template;
      expect(substituted.greeting).toBe("Hello Bob");
      expect(substituted.url).toBe("https://example.com/api");
    });

    it("interpolates variable and input templates in LLM Custom assertions", () => {
      const assertions: AssertionSpec[] = [
        {
          type: "llm_custom",
          expectation: "User name should be {{variables.targetUser}}",
          unexpectation: "Must not mention {{input.forbiddenKeyword}}",
          reference: "Standard policy of {{variables.orgName}}",
          context: ["Testing on environment {{variables.env}}"],
        },
      ];

      const outcome = evaluateAssertions({}, assertions, {
        input: { forbiddenKeyword: "ConfidentialSecret" },
        variables: { targetUser: "Alice", orgName: "Acme Corp", env: "production" },
      });

      expect(outcome.llmAssertions).toHaveLength(1);
      const resolvedLlm = outcome.llmAssertions[0].spec;
      expect(resolvedLlm.type).toBe("llm_custom");
      if (resolvedLlm.type === "llm_custom") {
        expect(resolvedLlm.expectation).toBe("User name should be Alice");
        expect(resolvedLlm.unexpectation).toBe("Must not mention ConfidentialSecret");
        expect(resolvedLlm.reference).toBe("Standard policy of Acme Corp");
        expect(resolvedLlm.context).toEqual(["Testing on environment production"]);
      }
    });

    it("normalizes case names", () => {
      expect(normalizeCaseName("  Test Case #1: Login Flow! ")).toBe("test_case_1_login_flow");
    });
  });

  describe("6. validateAssertionSyntax semantic pre-check", () => {
    it("validates js_expression syntax", () => {
      const valid = validateAssertionSyntax({
        type: "js_expression",
        expression: "result.status === 200 && input.id > 0",
      });
      expect(valid.ok).toBe(true);

      const invalid = validateAssertionSyntax({
        type: "js_expression",
        expression: "result.status === 200 && (input.id > 0",
      });
      expect(invalid.ok).toBe(false);
      expect(invalid.error).toContain("Invalid JavaScript expression syntax");

      const empty = validateAssertionSyntax({
        type: "js_expression",
        expression: "   ",
      });
      expect(empty.ok).toBe(false);
    });

    it("validates json_schema syntax with Ajv", () => {
      const valid = validateAssertionSyntax({
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
          required: ["name"],
        },
      });
      expect(valid.ok).toBe(true);

      const invalid = validateAssertionSyntax({
        type: "json_schema",
        schema: {
          type: "not_a_valid_json_schema_type",
        },
      });
      expect(invalid.ok).toBe(false);
      expect(invalid.error).toContain("Invalid JSON Schema");
    });

    it("validates json_schema syntax with $id repeatedly without collision", () => {
      const makeSchema = () => ({
        type: "json_schema" as const,
        schema: {
          $id: "https://example.com/user-spec.json",
          type: "object",
          properties: { id: { type: "number" } },
        },
      });

      // Call validateAssertionSyntax twice with separate object instances
      const firstCheck = validateAssertionSyntax(makeSchema());
      expect(firstCheck.ok).toBe(true);

      const secondCheck = validateAssertionSyntax(makeSchema());
      expect(secondCheck.ok).toBe(true);

      // Verify that genuine errors with $id are still caught
      const invalidWithId = validateAssertionSyntax({
        type: "json_schema",
        schema: {
          $id: "https://example.com/invalid-spec.json",
          type: "invalid_type_name",
        },
      });
      expect(invalidWithId.ok).toBe(false);
      expect(invalidWithId.error).toContain("Invalid JSON Schema");
    });

    it("validates jsonpath syntax", () => {
      const valid = validateAssertionSyntax({
        type: "jsonpath",
        path: "$.data.items[0].id",
      });
      expect(valid.ok).toBe(true);

      const validWithoutDollar = validateAssertionSyntax({
        type: "jsonpath",
        path: "data.items[*].id",
      });
      expect(validWithoutDollar.ok).toBe(true);

      const invalid = validateAssertionSyntax({
        type: "jsonpath",
        path: "$.items[?(@.id===)]",
      });
      expect(invalid.ok).toBe(false);
      expect(invalid.error).toContain("Invalid JSONPath syntax");
    });

    it("validates regex pattern in jsonpath matches operator", () => {
      const validRegex = validateAssertionSyntax({
        type: "jsonpath",
        path: "$.email",
        operator: "matches",
        expected: "^[a-z]+@[a-z]+\\.com$",
      });
      expect(validRegex.ok).toBe(true);

      const invalidRegex = validateAssertionSyntax({
        type: "jsonpath",
        path: "$.email",
        operator: "matches",
        expected: "[unclosed_regex_class",
      });
      expect(invalidRegex.ok).toBe(false);
      expect(invalidRegex.error).toContain("Invalid regular expression");

      // Template variable in expected should not trigger regex compile failure
      const templateRegex = validateAssertionSyntax({
        type: "jsonpath",
        path: "$.email",
        operator: "matches",
        expected: "{{variables.pattern}}",
      });
      expect(templateRegex.ok).toBe(true);
    });

    it("validates metric thresholds", () => {
      const valid = validateAssertionSyntax({
        type: "metric",
        metric: "duration_s",
        operator: "<",
        threshold: 2.5,
      });
      expect(valid.ok).toBe(true);

      const nan = validateAssertionSyntax({
        type: "metric",
        metric: "duration_s",
        operator: "<",
        threshold: Number.NaN,
      });
      expect(nan.ok).toBe(false);

      const infinity = validateAssertionSyntax({
        type: "metric",
        metric: "duration_s",
        operator: "<",
        threshold: Number.POSITIVE_INFINITY,
      });
      expect(infinity.ok).toBe(false);
    });
  });

  describe("7. Protocol _meta and multi-modal content extraction", () => {
    it("preserves and attaches _meta for JSONPath and JS expression assertions", () => {
      const payloadWithMeta = {
        content: [
          {
            type: "text",
            text: JSON.stringify({ user: { id: 101, name: "Alice" } }),
          },
        ],
        _meta: {
          traceId: "trace-xyz-789",
          cached: true,
          gatewayLatencyMs: 42,
        },
      };

      const assertions: AssertionSpec[] = [
        // Business field
        { type: "jsonpath", path: "user.id", operator: "==", expected: 101 },
        // _meta via structured path (without $)
        { type: "jsonpath", path: "_meta.traceId", operator: "==", expected: "trace-xyz-789" },
        // _meta via root envelope path (with $)
        { type: "jsonpath", path: "$._meta.cached", operator: "==", expected: true },
        // JS expression testing root._meta and result._meta
        {
          type: "js_expression",
          expression: "root._meta.traceId === 'trace-xyz-789' && result._meta.cached === true && _meta.gatewayLatencyMs === 42",
        },
      ];

      const outcome = evaluateAssertions(payloadWithMeta, assertions);
      expect(outcome.allDeterministicPassed).toBe(true);
      expect(outcome.deterministicResults).toHaveLength(4);
      expect(outcome.deterministicResults[0].ok).toBe(true);
      expect(outcome.deterministicResults[1].ok).toBe(true);
      expect(outcome.deterministicResults[2].ok).toBe(true);
      expect(outcome.deterministicResults[3].ok).toBe(true);
    });

    it("unwraps single non-text content items (e.g. image) for direct field assertions", () => {
      const imagePayload = {
        content: [
          {
            type: "image",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            mimeType: "image/png",
          },
        ],
        _meta: {
          dimensions: { width: 1, height: 1 },
        },
      };

      const assertions: AssertionSpec[] = [
        { type: "jsonpath", path: "type", operator: "==", expected: "image" },
        { type: "jsonpath", path: "mimeType", operator: "==", expected: "image/png" },
        { type: "jsonpath", path: "data", operator: "exists" },
        { type: "jsonpath", path: "_meta.dimensions.width", operator: "==", expected: 1 },
        {
          type: "js_expression",
          expression: "result.type === 'image' && result.mimeType === 'image/png' && root._meta.dimensions.height === 1",
        },
      ];

      const outcome = evaluateAssertions(imagePayload, assertions);
      expect(outcome.allDeterministicPassed).toBe(true);
      expect(outcome.deterministicResults).toHaveLength(5);
      expect(outcome.deterministicResults.every((r) => r.ok)).toBe(true);
    });
  });

  describe("8. Unified Bindings Model (root, $, result, _page)", () => {
    it("binds root and $ identically to the raw envelope in JS expressions", () => {
      const envelope = {
        content: [{ type: "text", text: JSON.stringify({ orderId: 1001, status: "completed" }) }],
        _meta: { traceId: "trace-abc-123", timestamp: 1700000000 },
      };

      const assertions: AssertionSpec[] = [
        // root and $ both point to the envelope
        {
          type: "js_expression",
          expression: "root._meta.traceId === 'trace-abc-123' && $._meta.traceId === 'trace-abc-123'",
        },
        {
          type: "js_expression",
          expression: "root === $ && $._meta.timestamp === 1700000000",
        },
        // result points to structured content
        {
          type: "js_expression",
          expression: "result.orderId === 1001 && result.status === 'completed'",
        },
        // direct field spread works
        {
          type: "js_expression",
          expression: "orderId === 1001 && status === 'completed'",
        },
      ];

      const outcome = evaluateAssertions(envelope, assertions);
      expect(outcome.allDeterministicPassed).toBe(true);
      expect(outcome.deterministicResults).toHaveLength(4);
    });

    it("evaluates JSONPath with root., $., result., and direct field paths", () => {
      const envelope = {
        content: [{ type: "text", text: JSON.stringify({ orderId: 1001, status: "completed" }) }],
        _meta: { traceId: "trace-abc-123" },
      };

      const assertions: AssertionSpec[] = [
        // Envelope paths
        { type: "jsonpath", path: "$._meta.traceId", expected: "trace-abc-123" },
        { type: "jsonpath", path: "root._meta.traceId", expected: "trace-abc-123" },
        // Business result paths
        { type: "jsonpath", path: "result.orderId", expected: 1001 },
        { type: "jsonpath", path: "orderId", expected: 1001 },
        { type: "jsonpath", path: "result.status", expected: "completed" },
        { type: "jsonpath", path: "status", expected: "completed" },
      ];

      const outcome = evaluateAssertions(envelope, assertions);
      expect(outcome.allDeterministicPassed).toBe(true);
      expect(outcome.deterministicResults).toHaveLength(6);
    });

    it("handles business data containing a field named result without ambiguity", () => {
      const payloadWithResultField = {
        content: [{ type: "text", text: JSON.stringify({ result: "APPROVED", code: 200 }) }],
      };

      const assertions: AssertionSpec[] = [
        // JSONPath: path: "result" matches the whole structured object
        {
          type: "jsonpath",
          path: "result",
          expected: { result: "APPROVED", code: 200 },
        },
        // JSONPath: path: "result.result" accesses the child property "result"
        {
          type: "jsonpath",
          path: "result.result",
          expected: "APPROVED",
        },
        // JSONPath: path: "result.code" and "code" access code
        {
          type: "jsonpath",
          path: "result.code",
          expected: 200,
        },
        {
          type: "jsonpath",
          path: "code",
          expected: 200,
        },
        // JS Expression: result.result accesses the child property, result is whole object
        {
          type: "js_expression",
          expression: "result.result === 'APPROVED' && result.code === 200 && code === 200",
        },
      ];

      const outcome = evaluateAssertions(payloadWithResultField, assertions);
      expect(outcome.allDeterministicPassed).toBe(true);
      expect(outcome.deterministicResults).toHaveLength(5);
    });

    it("correctly handles Web-Auto payload with _page metadata", () => {
      const webAutoPayload = {
        result: { count: 42, active: true },
        _page: { url: "https://example.com/checkout", title: "Checkout" },
      };

      const assertions: AssertionSpec[] = [
        // Envelope access for _page
        { type: "jsonpath", path: "$._page.url", expected: "https://example.com/checkout" },
        { type: "jsonpath", path: "root._page.title", expected: "Checkout" },
        // Business result access
        { type: "jsonpath", path: "result.count", expected: 42 },
        { type: "jsonpath", path: "count", expected: 42 },
        {
          type: "js_expression",
          expression: "root._page.url === 'https://example.com/checkout' && $._page.title === 'Checkout'",
        },
        {
          type: "js_expression",
          expression: "result.count === 42 && active === true",
        },
      ];

      const outcome = evaluateAssertions(webAutoPayload, assertions);
      expect(outcome.allDeterministicPassed).toBe(true);
      expect(outcome.deterministicResults).toHaveLength(6);
    });

    it("evaluates assertions with caller-supplied explicit { target, root, page } envelope", () => {
      const explicitEnvelope = {
        target: {
          orderId: "ORD-999",
          status: "confirmed",
          success: true,
          result: { innerToken: "tok-abc" },
        },
        root: {
          result: { orderId: "ORD-999", status: "confirmed", success: true, result: { innerToken: "tok-abc" } },
          _page: { url: "https://shop.example.com/checkout", title: "Order Confirmed" },
        },
        page: { url: "https://shop.example.com/checkout", title: "Order Confirmed" },
      };

      const assertions: AssertionSpec[] = [
        // Target business fields (direct and via result.)
        { type: "jsonpath", path: "orderId", expected: "ORD-999" },
        { type: "jsonpath", path: "result.orderId", expected: "ORD-999" },
        { type: "jsonpath", path: "result.result.innerToken", expected: "tok-abc" },
        // Outer envelope fields via root and $
        { type: "jsonpath", path: "root._page.url", expected: "https://shop.example.com/checkout" },
        { type: "jsonpath", path: "$._page.title", expected: "Order Confirmed" },
        // JS expressions
        {
          type: "js_expression",
          expression: "orderId === 'ORD-999' && result.success === true && result.result.innerToken === 'tok-abc'",
        },
        {
          type: "js_expression",
          expression: "root._page.url === 'https://shop.example.com/checkout' && $._page.title === 'Order Confirmed'",
        },
      ];

      const outcome = evaluateAssertions(explicitEnvelope, assertions);
      expect(outcome.allDeterministicPassed).toBe(true);
      expect(outcome.deterministicResults).toHaveLength(7);
      expect(outcome.deterministicResults.every((r) => r.ok)).toBe(true);
    });

    it("evaluates assertions with options.root and options.page", () => {
      const target = { count: 123, ready: true };
      const root = {
        result: target,
        _page: { url: "https://example.com/status" },
      };

      const assertions: AssertionSpec[] = [
        { type: "jsonpath", path: "count", expected: 123 },
        { type: "jsonpath", path: "root._page.url", expected: "https://example.com/status" },
        { type: "js_expression", expression: "count === 123 && $._page.url === 'https://example.com/status'" },
      ];

      const outcome = evaluateAssertions(target, assertions, {
        root,
        page: root._page,
      });

      expect(outcome.allDeterministicPassed).toBe(true);
      expect(outcome.deterministicResults).toHaveLength(3);
    });

    it("does not demangle non-envelope objects containing result property", () => {
      // Direct business JSON without _page or content: should NOT be unwrapped!
      const plainBusinessPayload = {
        result: "SUCCESS",
        count: 10,
        details: { mode: "batch" },
      };

      const assertions: AssertionSpec[] = [
        // count is NOT stripped
        { type: "jsonpath", path: "count", expected: 10 },
        { type: "jsonpath", path: "result.count", expected: 10 },
        { type: "jsonpath", path: "result.result", expected: "SUCCESS" },
        {
          type: "js_expression",
          expression: "count === 10 && result.result === 'SUCCESS' && result.details.mode === 'batch'",
        },
      ];

      const outcome = evaluateAssertions(plainBusinessPayload, assertions);
      expect(outcome.allDeterministicPassed).toBe(true);
      expect(outcome.deterministicResults).toHaveLength(4);
    });

    it("supports cases in JS expressions using standard bracket syntax", () => {
      const payload = {
        content: [{ type: "text", text: JSON.stringify({ userId: "u-999" }) }],
      };

      const assertions: AssertionSpec[] = [
        {
          type: "js_expression",
          expression: "cases['010'].output.createdId === result.userId",
        },
      ];

      const outcome = evaluateAssertions(payload, assertions, {
        runContext: {
          cases: {
            "010": { output: { createdId: "u-999" } },
          },
        },
      });

      expect(outcome.allDeterministicPassed).toBe(true);
      expect(outcome.deterministicResults[0].ok).toBe(true);
    });

    it("supports input, variables, and cases simultaneously across JSONPath and JS expressions", () => {
      const payload = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              orderId: "ORD-500",
              environment: "staging",
              token: "tok-abc",
            }),
          },
        ],
      };

      const assertions: AssertionSpec[] = [
        // JSONPath with string templates
        { type: "jsonpath", path: "orderId", expected: "{{input.expectedOrderId}}" },
        { type: "jsonpath", path: "environment", expected: "{{variables.ENV}}" },
        { type: "jsonpath", path: "token", expected: "{{cases.010.output.token}}" },
        // JS expression with native syntax
        {
          type: "js_expression",
          expression:
            "result.orderId === input.expectedOrderId && " +
            "result.environment === variables.ENV && " +
            "result.token === cases['010'].output.token",
        },
      ];

      const outcome = evaluateAssertions(payload, assertions, {
        input: { expectedOrderId: "ORD-500" },
        variables: { ENV: "staging" },
        runContext: {
          cases: {
            "010": { output: { token: "tok-abc" } },
          },
        },
      });

      expect(outcome.allDeterministicPassed).toBe(true);
      expect(outcome.deterministicResults).toHaveLength(4);
      expect(outcome.deterministicResults.every((r) => r.ok)).toBe(true);
    });
  });

  describe("js_expression actual value extraction on failure", () => {
    it("extracts LHS actual value for failing comparison assertions (e.g. array length)", () => {
      const payload = {
        results: [1, 2, 3],
        status: "pending",
        count: 0,
      };

      const assertions: AssertionSpec[] = [
        { type: "js_expression", expression: "result.results.length > 10" },
        { type: "js_expression", expression: "result.status === 'success'" },
        { type: "js_expression", expression: "result.count >= 1" },
        { type: "js_expression", expression: "result.results.length === 5" },
      ];

      const outcome = evaluateAssertions(payload, assertions);
      expect(outcome.allDeterministicPassed).toBe(false);
      expect(outcome.deterministicResults).toHaveLength(4);

      // result.results.length > 10 -> actual: 3
      expect(outcome.deterministicResults[0].ok).toBe(false);
      expect(outcome.deterministicResults[0].actual).toBe(3);
      expect(outcome.deterministicResults[0].expected).toBe(10);
      expect(outcome.deterministicResults[0].operator).toBe(">");

      // result.status === 'success' -> actual: 'pending'
      expect(outcome.deterministicResults[1].ok).toBe(false);
      expect(outcome.deterministicResults[1].actual).toBe("pending");
      expect(outcome.deterministicResults[1].expected).toBe("success");
      expect(outcome.deterministicResults[1].operator).toBe("===");

      // result.count >= 1 -> actual: 0
      expect(outcome.deterministicResults[2].ok).toBe(false);
      expect(outcome.deterministicResults[2].actual).toBe(0);
      expect(outcome.deterministicResults[2].expected).toBe(1);
      expect(outcome.deterministicResults[2].operator).toBe(">=");

      // result.results.length === 5 -> actual: 3, expected: 5, operator: '==='
      expect(outcome.deterministicResults[3].ok).toBe(false);
      expect(outcome.deterministicResults[3].actual).toBe(3);
      expect(outcome.deterministicResults[3].expected).toBe(5);
      expect(outcome.deterministicResults[3].operator).toBe("===");
    });

    it("extracts failing sub-expression actual value in compound && expressions", () => {
      const payload = {
        results: [1, 2, 3],
      };

      const assertions: AssertionSpec[] = [
        { type: "js_expression", expression: "result.results && result.results.length > 10" },
      ];

      const outcome = evaluateAssertions(payload, assertions);
      expect(outcome.deterministicResults[0].ok).toBe(false);
      expect(outcome.deterministicResults[0].actual).toBe(3);
    });
  });

  describe("7. text_match deterministic assertions", () => {
    const stringPayload = "Welcome to Nango! Check our docs at https://docs.nango.dev for details.";
    const objectPayload = {
      text: "The order #ORD-12345 has been confirmed successfully.",
    };

    it("evaluates 'contains' operator (case-insensitive by default and case-sensitive)", () => {
      const assertions: AssertionSpec[] = [
        { type: "text_match", operator: "contains", expected: "welcome to nango" },
        { type: "text_match", operator: "contains", expected: "WELCOME TO NANGO", caseSensitive: true },
        { type: "text_match", operator: "contains", expected: "https://docs.nango.dev" },
      ];

      const outcome = evaluateAssertions(stringPayload, assertions);
      expect(outcome.deterministicResults[0].ok).toBe(true);
      expect(outcome.deterministicResults[1].ok).toBe(false);
      expect(outcome.deterministicResults[1].message).toContain('Expected text to contain "WELCOME TO NANGO"');
      expect(outcome.deterministicResults[2].ok).toBe(true);
    });

    it("evaluates 'not_contains' operator", () => {
      const assertions: AssertionSpec[] = [
        { type: "text_match", operator: "not_contains", expected: "error" },
        { type: "text_match", operator: "not_contains", expected: "nango" },
      ];

      const outcome = evaluateAssertions(stringPayload, assertions);
      expect(outcome.deterministicResults[0].ok).toBe(true);
      expect(outcome.deterministicResults[1].ok).toBe(false);
      expect(outcome.deterministicResults[1].message).toContain('Expected text NOT to contain "nango"');
    });

    it("evaluates 'matches' regular expression operator", () => {
      const assertions: AssertionSpec[] = [
        { type: "text_match", operator: "matches", expected: "#ORD-\\d{5}" },
        { type: "text_match", operator: "matches", expected: "^The order.*confirmed" },
        { type: "text_match", operator: "matches", expected: "^The ORDER.*confirmed", caseSensitive: true },
      ];

      const outcome = evaluateAssertions(objectPayload, assertions);
      expect(outcome.deterministicResults[0].ok).toBe(true);
      expect(outcome.deterministicResults[1].ok).toBe(true);
      expect(outcome.deterministicResults[2].ok).toBe(false);
    });

    it("validates text_match syntax via validateAssertionSyntax", () => {
      const valid = validateAssertionSyntax({
        type: "text_match",
        operator: "contains",
        expected: "hello",
      });
      expect(valid.ok).toBe(true);

      const empty = validateAssertionSyntax({
        type: "text_match",
        operator: "contains",
        expected: "",
      });
      expect(empty.ok).toBe(false);

      const invalidOp = validateAssertionSyntax({
        type: "text_match",
        operator: "starts_with",
        expected: "hello",
      });
      expect(invalidOp.ok).toBe(false);

      const invalidRegex = validateAssertionSyntax({
        type: "text_match",
        operator: "matches",
        expected: "[unclosed-group",
      });
      expect(invalidRegex.ok).toBe(false);
    });
  });

  describe("8. normalizeTargetEnvelope fallback paths and explicit target/page addressing", () => {
    it("handles explicit { target, root, page } envelope directly", () => {
      const envelope = {
        target: { orderId: "123", status: "completed" },
        root: { result: { orderId: "123" }, _page: { url: "https://test.com" } },
        page: { url: "https://test.com" },
      };
      const normalized = normalizeTargetEnvelope(envelope);
      expect(normalized.target).toEqual({ orderId: "123", status: "completed" });
      expect(normalized.root).toBe(envelope.root);
      expect(normalized.page).toEqual({ url: "https://test.com" });
    });

    it("extracts root and page from options when target is passed directly", () => {
      const target = { orderId: "123" };
      const options = {
        root: { result: target, _page: { url: "https://example.com" } },
        page: { url: "https://example.com" },
      };
      const normalized = normalizeTargetEnvelope(target, options);
      expect(normalized.target).toBe(target);
      expect(normalized.root).toBe(options.root);
      expect(normalized.page).toEqual({ url: "https://example.com" });
    });

    it("falls back to runContext.root and runContext._page when options root/page are absent", () => {
      const target = { orderId: "456" };
      const options = {
        runContext: {
          root: { result: target, _page: { title: "Checkout" } },
          _page: { title: "Checkout" },
        },
      };
      const normalized = normalizeTargetEnvelope(target, options);
      expect(normalized.target).toBe(target);
      expect(normalized.root).toEqual({ result: target, _page: { title: "Checkout" } });
      expect(normalized.page).toEqual({ title: "Checkout" });
    });

    it("unwraps legacy Web Auto envelope { result, _page } seamlessly", () => {
      const legacyPayload = {
        result: { newsTitle: "Breaking News", count: 42 },
        _page: { url: "https://news.example.com", title: "News Portal" },
      };
      const normalized = normalizeTargetEnvelope(legacyPayload);
      expect(normalized.target).toEqual({ newsTitle: "Breaking News", count: 42 });
      expect(normalized.root).toBe(legacyPayload);
      expect(normalized.page).toEqual({ url: "https://news.example.com", title: "News Portal" });
    });

    it("falls back to payload as both target and root for primitives or plain objects", () => {
      const plain = { name: "Alice", age: 30 };
      const normalized = normalizeTargetEnvelope(plain);
      expect(normalized.target).toBe(plain);
      expect(normalized.root).toBe(plain);
      expect(normalized.page).toBeUndefined();

      const primitive = "string-result";
      const normPrim = normalizeTargetEnvelope(primitive);
      expect(normPrim.target).toBe("string-result");
      expect(normPrim.root).toBe("string-result");
      expect(normPrim.page).toBeUndefined();
    });

    it("resolves target.*, result.*, page.*, and _page.* correctly in JSONPath assertions", () => {
      const payload = {
        target: { orderId: "ORD-999", amount: 150 },
        root: {
          result: { orderId: "ORD-999", amount: 150 },
          _page: { url: "https://shop.example.com/order/999", title: "Order Confirmation" },
        },
        page: { url: "https://shop.example.com/order/999", title: "Order Confirmation" },
      };

      const assertions: AssertionSpec[] = [
        { type: "jsonpath", path: "target.orderId", operator: "==", expected: "ORD-999" },
        { type: "jsonpath", path: "result.amount", operator: "==", expected: 150 },
        { type: "jsonpath", path: "page.title", operator: "==", expected: "Order Confirmation" },
        { type: "jsonpath", path: "_page.url", operator: "==", expected: "https://shop.example.com/order/999" },
      ];

      const outcome = evaluateAssertions(payload, assertions);
      expect(outcome.allDeterministicPassed).toBe(true);
      expect(outcome.deterministicResults[0].ok).toBe(true);
      expect(outcome.deterministicResults[1].ok).toBe(true);
      expect(outcome.deterministicResults[2].ok).toBe(true);
      expect(outcome.deterministicResults[3].ok).toBe(true);
    });
  });

  describe("A4 / A10 / A11 Deterministic Assertion Fixes", () => {
    it("A4: prevents variables from overwriting real business evidence like result", () => {
      const payload = { ok: false };
      const options = {
        variables: {
          result: { ok: true },
        },
      };

      const assertions: AssertionSpec[] = [
        {
          type: "js_expression",
          expression: "result.ok === true",
        },
        {
          type: "js_expression",
          expression: "variables.result.ok === true && result.ok === false",
        },
      ];

      const outcome = evaluateAssertions(payload, assertions, options);
      // First assertion: result.ok === true must fail because real result.ok is false
      expect(outcome.deterministicResults[0].ok).toBe(false);
      // Second assertion: variables.result is explicitly accessible under variables namespace
      expect(outcome.deterministicResults[1].ok).toBe(true);
    });

    it("A10: checks all inner elements in nested wildcards and identifies failed element paths", () => {
      const payload = {
        groups: [
          {
            items: [{ ok: true }, { ok: false }],
          },
        ],
      };

      const assertions: AssertionSpec[] = [
        {
          type: "jsonpath",
          path: "groups[*].items[*].ok",
          operator: "==",
          expected: true,
        },
      ];

      const outcome = evaluateAssertions(payload, assertions);
      expect(outcome.allDeterministicPassed).toBe(false);
      expect(outcome.deterministicResults[0].ok).toBe(false);
      expect(outcome.deterministicResults[0].actual).toEqual(["groups[0].items[1]"]);
      expect(outcome.deterministicResults[0].message).toBe("unsatisfied item(s): [groups[0].items[1]]");
    });

    it("A10: catches missing leaf fields in nested wildcards without dropping them", () => {
      const payload = {
        groups: [
          {
            items: [{ ok: true }, {}],
          },
        ],
      };

      const assertions: AssertionSpec[] = [
        {
          type: "jsonpath",
          path: "groups[*].items[*].ok",
          operator: "==",
          expected: true,
        },
      ];

      const outcome = evaluateAssertions(payload, assertions);
      expect(outcome.allDeterministicPassed).toBe(false);
      expect(outcome.deterministicResults[0].ok).toBe(false);
      expect(outcome.deterministicResults[0].actual).toEqual(["groups[0].items[1]"]);
    });

    it("A10: passes when all items across all groups satisfy the nested condition", () => {
      const payload = {
        groups: [
          {
            items: [{ ok: true }, { ok: true }],
          },
          {
            items: [{ ok: true }],
          },
        ],
      };

      const assertions: AssertionSpec[] = [
        {
          type: "jsonpath",
          path: "groups[*].items[*].ok",
          operator: "==",
          expected: true,
        },
      ];

      const outcome = evaluateAssertions(payload, assertions);
      expect(outcome.allDeterministicPassed).toBe(true);
      expect(outcome.deterministicResults[0].ok).toBe(true);
    });

    it("A11: rejects missing field comparing to empty array, but accepts real empty array", () => {
      const missingPayload = {};
      const emptyArrayPayload = { missing: [] };

      const assertion: AssertionSpec[] = [
        {
          type: "jsonpath",
          path: "missing",
          operator: "==",
          expected: [],
        },
      ];

      // Missing field must fail
      const outcomeMissing = evaluateAssertions(missingPayload, assertion);
      expect(outcomeMissing.allDeterministicPassed).toBe(false);
      expect(outcomeMissing.deterministicResults[0].ok).toBe(false);
      expect(outcomeMissing.deterministicResults[0].message).toContain("does not exist");

      // Actual empty array must pass
      const outcomeEmptyArray = evaluateAssertions(emptyArrayPayload, assertion);
      expect(outcomeEmptyArray.allDeterministicPassed).toBe(true);
      expect(outcomeEmptyArray.deterministicResults[0].ok).toBe(true);
    });

    it("Preserves single-layer wildcard behavior and exists operator semantics", () => {
      const payload = {
        items: [{ val: 10 }, { val: 0 }],
        active: "yes",
      };

      const assertions: AssertionSpec[] = [
        {
          type: "jsonpath",
          path: "items[*].val",
          operator: ">",
          expected: 0,
        },
        {
          type: "jsonpath",
          path: "active",
          operator: "exists",
        },
        {
          type: "jsonpath",
          path: "nonexistent",
          operator: "exists",
        },
      ];

      const outcome = evaluateAssertions(payload, assertions);
      expect(outcome.deterministicResults[0].ok).toBe(false);
      expect(outcome.deterministicResults[0].actual).toEqual([1]);
      expect(outcome.deterministicResults[1].ok).toBe(true);
      expect(outcome.deterministicResults[1].actual).toBe("exists");
      expect(outcome.deterministicResults[2].ok).toBe(false);
      expect(outcome.deterministicResults[2].actual).toBe("missing");
    });
  });
});

