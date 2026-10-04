import { describe, expect, it } from "vitest";
import { evaluateAssertions } from "@/lib/assertions/evaluator.server";
import { normalizeAndValidateAssertions } from "@/lib/testing/assertion-validation";
import { CATEGORY_TYPE_MAPPING, type AssertionSpec } from "@/lib/assertions/types";

describe("Phase 2 — Assertions, Categories, and Errored State", () => {
  it("allows metric assertion for verification category in CATEGORY_TYPE_MAPPING", () => {
    expect(CATEGORY_TYPE_MAPPING.verification).toContain("metric");
  });

  it("validates and accepts metric assertion in verification category", () => {
    const raw = [
      {
        type: "metric",
        metric: "duration_s",
        operator: "<",
        threshold: 2.5,
      },
    ];
    const validated = normalizeAndValidateAssertions(raw, "case_perf", "verification");
    expect(validated).toHaveLength(1);
    expect(validated[0].metric).toBe("duration_s");
  });

  it("rejects unsupported assertion types (e.g. llm_custom) for verification category with clear error", () => {
    const raw = [
      {
        type: "llm_custom",
        expectation: "Tool should succeed gracefully",
      },
    ];
    expect(() =>
      normalizeAndValidateAssertions(raw, "case_invalid", "verification"),
    ).toThrow(/type 'llm_custom' is not supported for category 'verification'/);
  });

  it("sets errored: true on JSONPath syntax parse failure", () => {
    const assertions: AssertionSpec[] = [
      {
        type: "jsonpath",
        path: "$[?(@.foo > )]",
        expected: "value",
      },
    ];
    const outcome = evaluateAssertions({ foo: "bar" }, assertions);
    expect(outcome.allDeterministicPassed).toBe(false);
    expect(outcome.deterministicResults[0].errored).toBe(true);
    expect(outcome.deterministicResults[0].errorSource).toBe("config");
  });

  it("sets errored: true on JSON Schema compile failure", () => {
    const assertions: AssertionSpec[] = [
      {
        type: "json_schema",
        schema: {
          type: "invalid_schema_type_that_fails_compile",
        },
      },
    ];
    const outcome = evaluateAssertions({ foo: "bar" }, assertions);
    expect(outcome.allDeterministicPassed).toBe(false);
    expect(outcome.deterministicResults[0].errored).toBe(true);
    expect(outcome.deterministicResults[0].errorSource).toBe("config");
  });

  it("distinguishes JS expression syntax error (errored: true) from runtime property miss", () => {
    const syntaxErrAssertions: AssertionSpec[] = [
      {
        type: "js_expression",
        expression: "function((( { broken syntax",
      },
    ];
    const syntaxOutcome = evaluateAssertions({ foo: "bar" }, syntaxErrAssertions);
    expect(syntaxOutcome.deterministicResults[0].errored).toBe(true);
    expect(syntaxOutcome.deterministicResults[0].errorSource).toBe("config");

    // Runtime TypeError (reading property of undefined, e.g. target data missing) -> ok: false, errored: undefined (failed, not errored)
    const runtimeErrAssertions: AssertionSpec[] = [
      {
        type: "js_expression",
        expression: "result.nonexistent.nested === 42",
      },
    ];
    const runtimeOutcome = evaluateAssertions({ foo: "bar" }, runtimeErrAssertions);
    expect(runtimeOutcome.deterministicResults[0].ok).toBe(false);
    expect(runtimeOutcome.deterministicResults[0].errored).toBeUndefined();
  });

  it("correctly evaluates duration_s metric against provided execution duration", () => {
    const assertions: AssertionSpec[] = [
      {
        type: "metric",
        metric: "duration_s",
        operator: "<",
        threshold: 1.5,
      },
    ];
    // 1200ms = 1.2s < 1.5s -> pass
    const passOutcome = evaluateAssertions(
      { success: true },
      assertions,
      { metrics: { durationMs: 1200 } },
    );
    expect(passOutcome.allDeterministicPassed).toBe(true);

    // 2500ms = 2.5s > 1.5s -> fail
    const failOutcome = evaluateAssertions(
      { success: true },
      assertions,
      { metrics: { durationMs: 2500 } },
    );
    expect(failOutcome.allDeterministicPassed).toBe(false);
    expect(failOutcome.deterministicResults[0].ok).toBe(false);
  });

  it("evaluates jsonRpcError payload with data for negative testing", () => {
    const payload = {
      jsonRpcError: {
        code: -32602,
        message: "Invalid params: id must be a string",
        data: {
          field: "id",
          expectedType: "string",
          receivedType: "number",
        },
      },
    };
    const assertions: AssertionSpec[] = [
      {
        type: "jsonpath",
        path: "$.jsonRpcError.code",
        operator: "==",
        expected: -32602,
      },
      {
        type: "jsonpath",
        path: "$.jsonRpcError.data.field",
        operator: "==",
        expected: "id",
      },
    ];
    const outcome = evaluateAssertions(payload, assertions);
    expect(outcome.allDeterministicPassed).toBe(true);
  });

  it("extracts data and code onto TOOL_FAILURE_CAUSE in toToolFailure", async () => {
    const { toToolFailure, TOOL_FAILURE_CAUSE } = await import("@/lib/runner/tool-failure");
    const fakeMcpError = Object.assign(new Error("Invalid params"), {
      code: -32602,
      data: { details: "missing field foo" },
    });
    const failure = toToolFailure(fakeMcpError, "test_tool");
    expect(failure.isError).toBe(true);
    const cause = (failure as unknown as Record<symbol, unknown>)[TOOL_FAILURE_CAUSE] as {
      code?: number;
      data?: unknown;
    };
    expect(cause).toBeDefined();
    expect(cause.code).toBe(-32602);
    expect(cause.data).toEqual({ details: "missing field foo" });
  });

  it("allows duration_s and output_chars in CATEGORY_METRIC_MAPPING for verification and web-auto", async () => {
    const { CATEGORY_METRIC_MAPPING } = await import("@/lib/assertions/types");
    expect(CATEGORY_METRIC_MAPPING.verification).toEqual(["duration_s", "output_chars"]);
    expect(CATEGORY_METRIC_MAPPING["web-auto"]).toEqual(["duration_s", "output_chars"]);
    expect(CATEGORY_METRIC_MAPPING.evaluation).toContain("output_chars");
    expect(CATEGORY_METRIC_MAPPING.evaluation).toContain("total_tool_calls");
  });

  it("accepts output_chars for verification and web-auto, but rejects evaluation-only metrics in normalizeAndValidateAssertions", () => {
    const charAssertion = [
      {
        type: "metric",
        metric: "output_chars",
        operator: "<",
        threshold: 100,
      },
    ];
    // Valid for verification
    const validForVerif = normalizeAndValidateAssertions(charAssertion, "case_chars", "verification");
    expect(validForVerif).toHaveLength(1);
    expect(validForVerif[0].metric).toBe("output_chars");

    // Valid for web-auto
    const validForWebAuto = normalizeAndValidateAssertions(charAssertion, "case_chars", "web-auto");
    expect(validForWebAuto).toHaveLength(1);
    expect(validForWebAuto[0].metric).toBe("output_chars");

    // Evaluation-only metric total_tool_calls rejected for verification
    const toolCallAssertion = [
      {
        type: "metric",
        metric: "total_tool_calls",
        operator: "<",
        threshold: 5,
      },
    ];
    expect(() =>
      normalizeAndValidateAssertions(toolCallAssertion, "case_tools", "verification"),
    ).toThrow(/metric 'total_tool_calls' is not supported for category 'verification'/);
  });

  it("sets errored: true on unrecorded metrics in evaluateMetric to uphold three-state contract", () => {
    const assertions: AssertionSpec[] = [
      {
        type: "metric",
        metric: "output_chars",
        operator: "<",
        threshold: 100,
      },
    ];
    // No outputChars provided in metrics
    const outcome = evaluateAssertions({ success: true }, assertions, {
      metrics: { durationMs: 500 },
    });
    expect(outcome.allDeterministicPassed).toBe(false);
    expect(outcome.deterministicResults[0].errored).toBe(true);
    expect(outcome.deterministicResults[0].errorSource).toBe("config");
    expect(outcome.deterministicResults[0].message).toContain("was not recorded for this execution");
  });

  it("evaluates output_chars metric assertion accurately when outputChars is provided", () => {
    const assertions: AssertionSpec[] = [
      {
        type: "metric",
        metric: "output_chars",
        operator: "<",
        threshold: 50,
      },
    ];
    const passingOutcome = evaluateAssertions({ text: "hello" }, assertions, {
      metrics: { durationMs: 100, outputChars: 30 },
    });
    expect(passingOutcome.allDeterministicPassed).toBe(true);
    expect(passingOutcome.deterministicResults[0].ok).toBe(true);
    expect(passingOutcome.deterministicResults[0].actual).toBe(30);

    const failingOutcome = evaluateAssertions({ text: "hello" }, assertions, {
      metrics: { durationMs: 100, outputChars: 150 },
    });
    expect(failingOutcome.allDeterministicPassed).toBe(false);
    expect(failingOutcome.deterministicResults[0].ok).toBe(false);
    expect(failingOutcome.deterministicResults[0].actual).toBe(150);
  });

  it("rejects assertions with syntax errors in assertionsArraySchema (save pre-check)", async () => {
    const { assertionsArraySchema } = await import("@/lib/verification/wire-schemas");

    // Invalid JS expression syntax
    const badJs = assertionsArraySchema.safeParse([
      { type: "js_expression", expression: "foo === && bar" },
    ]);
    expect(badJs.success).toBe(false);
    if (!badJs.success) {
      expect(badJs.error.issues[0].message).toContain("Invalid JavaScript expression syntax");
    }

    // Invalid JSON schema
    const badSchema = assertionsArraySchema.safeParse([
      { type: "json_schema", schema: { type: "invalid_type" } },
    ]);
    expect(badSchema.success).toBe(false);
    if (!badSchema.success) {
      expect(badSchema.error.issues[0].message).toContain("Invalid JSON Schema");
    }

    // Invalid JSONPath
    const badJsonPath = assertionsArraySchema.safeParse([
      { type: "jsonpath", path: "$.foo[?(@.bar===)]" },
    ]);
    expect(badJsonPath.success).toBe(false);
    if (!badJsonPath.success) {
      expect(badJsonPath.error.issues[0].message).toContain("Invalid JSONPath syntax");
    }

    // Valid assertions pass
    const valid = assertionsArraySchema.safeParse([
      { type: "js_expression", expression: "result.ok === true" },
      { type: "jsonpath", path: "$.data.id", operator: "==", expected: 1 },
      { type: "json_schema", schema: { type: "object" } },
      { type: "metric", metric: "duration_s", operator: "<", threshold: 10 },
    ]);
    expect(valid.success).toBe(true);
  });
});
