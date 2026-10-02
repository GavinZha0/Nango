import { describe, it, expect } from "vitest";

import {
  evaluateAssertions,
  resolveInput,
  substituteInputTemplates,
  normalizeCaseName,
  validateAssertionSyntax,
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


    it("never exposes the page handle to js_expression", () => {
      const payload = { result: { status: "ok", count: 5 }, page: { evaluate: () => "host-secret" } };
      const assertions: AssertionSpec[] = [
        { type: "js_expression", expression: "result.count === 5" },
        { type: "js_expression", expression: "typeof page !== 'undefined'" },
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
          expectedCalls: 1,
          expectedArgs: { query: "refund policy" },
        },
        {
          type: "tool_call",
          toolName: "delete_database",
          expectedCalls: 0, // forbidden
        },
        {
          type: "tool_call",
          toolName: "charge_credit_card",
          expectedCalls: 1, // missing tool call
        },
      ];

      const outcome = evaluateAssertions({}, assertions, options);
      expect(outcome.deterministicResults[0].ok).toBe(true);
      expect(outcome.deterministicResults[1].ok).toBe(true);
      expect(outcome.deterministicResults[2].ok).toBe(false);
    });
  });

  describe("5. Metric assertions", () => {
    const options = {
      metrics: {
        durationMs: 3200,
        outputTokens: 450,
        toolCallCount: 2,
      },
    };

    it("evaluates performance and resource metrics", () => {
      const assertions: AssertionSpec[] = [
        { type: "metric", metric: "duration_s", operator: "<=", threshold: 5 },
        { type: "metric", metric: "output_tokens", operator: "<", threshold: 1000 },
        { type: "metric", metric: "total_tool_calls", operator: "<=", threshold: 3 },
        // Failed rule: 3.2s <= 2s is false
        { type: "metric", metric: "duration_s", operator: "<=", threshold: 2 },
      ];

      const outcome = evaluateAssertions({}, assertions, options);
      expect(outcome.deterministicResults[0].ok).toBe(true);
      expect(outcome.deterministicResults[0].actual).toBe(3.2);
      expect(outcome.deterministicResults[1].ok).toBe(true);
      expect(outcome.deterministicResults[2].ok).toBe(true);
      expect(outcome.deterministicResults[3].ok).toBe(false);
      expect(outcome.deterministicResults[3].actual).toBe(3.2);
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
});
