import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  evaluateAssertions,
  resolveInput,
  substituteInputTemplates,
  normalizeCaseName,
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

  describe("6. LLM Judge partitioning", () => {
    it("partitions LLM judge assertions for Tier 2 evaluation", () => {
      const assertions: AssertionSpec[] = [
        { type: "jsonpath", path: "$.status", operator: "==", expected: "ok" },
        { type: "llm_judge", expectation: "Assistant should explain the policy politely", reference: "Refunds take 3 days." },
        { type: "expectation", expectation: "Banner should display successfully" },
      ];

      const outcome = evaluateAssertions({ status: "ok" }, assertions);
      expect(outcome.deterministicResults).toHaveLength(1);
      expect(outcome.deterministicResults[0].ok).toBe(true);
      expect(outcome.llmAssertions).toHaveLength(2);
      expect(outcome.llmAssertions[0].spec.expectation).toBe("Assistant should explain the policy politely");
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

    it("interpolates variable and input templates in LLM Judge assertions", () => {
      const assertions: AssertionSpec[] = [
        {
          type: "llm_judge",
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
      expect(resolvedLlm.expectation).toBe("User name should be Alice");
      expect(resolvedLlm.unexpectation).toBe("Must not mention ConfidentialSecret");
      expect(resolvedLlm.reference).toBe("Standard policy of Acme Corp");
      expect(resolvedLlm.context).toEqual(["Testing on environment production"]);
    });

    it("normalizes case names", () => {
      expect(normalizeCaseName("  Test Case #1: Login Flow! ")).toBe("test_case_1_login_flow");
    });
  });
});
