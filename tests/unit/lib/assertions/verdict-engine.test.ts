import { describe, it, expect } from "vitest";

import { determineCaseVerdict } from "@/lib/assertions/verdict-engine.server";
import type { AssertionSpec, AssertionResult } from "@/lib/assertions";

describe("Case Verdict Engine (determineCaseVerdict)", () => {
  it("marks verdict as errored when a deterministic assertion result is missing", () => {
    const assertions: AssertionSpec[] = [
      {
        type: "metric",
        metric: "duration_s",
        operator: "<",
        threshold: 5,
      },
      {
        type: "js_expression",
        expression: "result.success === true",
      },
    ];

    // Only result for index 0 is provided; index 1 is missing
    const deterministicResults: AssertionResult[] = [
      {
        index: 0,
        type: "metric",
        ok: true,
        metric: "duration_s",
        actual: 2,
        expected: "< 5",
      },
    ];

    const outcome = determineCaseVerdict({
      assertions,
      deterministicResults,
    });

    expect(outcome.status).toBe("errored");
    expect(outcome.assertionResults).toHaveLength(2);
    expect(outcome.assertionResults[0].ok).toBe(true);
    expect(outcome.assertionResults[1].ok).toBe(false);
    expect(outcome.assertionResults[1].errored).toBe(true);
    expect(outcome.assertionResults[1].message).toBe("Missing deterministic evaluation result");
    expect(outcome.feedback).toBe("One or more deterministic assertions errored during execution.");
  });

  it("marks verdict as errored when duplicate deterministic indices are provided", () => {
    const assertions: AssertionSpec[] = [
      {
        type: "js_expression",
        expression: "result.count > 0",
      },
    ];

    const deterministicResults: AssertionResult[] = [
      {
        index: 0,
        type: "js_expression",
        ok: false,
      },
      {
        index: 0,
        type: "js_expression",
        ok: true,
      },
    ];

    const outcome = determineCaseVerdict({
      assertions,
      deterministicResults,
    });

    expect(outcome.status).toBe("errored");
    expect(outcome.assertionResults[0].errored).toBe(true);
    expect(outcome.assertionResults[0].message).toContain("Duplicate deterministic evaluation result");
  });

  it("marks verdict as errored when unknown out-of-bounds indices are provided", () => {
    const assertions: AssertionSpec[] = [
      {
        type: "js_expression",
        expression: "result.ok === true",
      },
    ];

    const deterministicResults: AssertionResult[] = [
      {
        index: 0,
        type: "js_expression",
        ok: true,
      },
      {
        index: 99,
        type: "js_expression",
        ok: true,
      },
    ];

    const outcome = determineCaseVerdict({
      assertions,
      deterministicResults,
    });

    expect(outcome.status).toBe("errored");
    expect(outcome.feedback).toContain("unknown or invalid assertion indices");
  });

  it("permits smoke tests when assertions array is legally empty and no unknown indices exist", () => {
    const outcome = determineCaseVerdict({
      assertions: [],
      deterministicResults: [],
    });

    expect(outcome.status).toBe("passed");
    expect(outcome.assertionResults).toHaveLength(0);
    expect(outcome.feedback).toBe("Smoke test passed (no assertions declared).");
  });

  it("rejects smoke tests when unexpected result indices are passed with empty assertions", () => {
    const outcome = determineCaseVerdict({
      assertions: [],
      deterministicResults: [
        {
          index: 0,
          type: "js_expression",
          ok: true,
        },
      ],
    });

    expect(outcome.status).toBe("errored");
    expect(outcome.feedback).toContain("unknown or invalid assertion indices");
  });

  it("short-circuits LLM evaluations when a deterministic item errors due to missing result", () => {
    const assertions: AssertionSpec[] = [
      {
        type: "js_expression",
        expression: "result.ok === true",
      },
      {
        type: "llm_custom",
        expectation: "Clear response tone",
      },
    ];

    // Missing index 0
    const outcome = determineCaseVerdict({
      assertions,
      deterministicResults: [],
      llmScores: [{ index: 1, score: 5 }],
    });

    expect(outcome.status).toBe("errored");
    expect(outcome.assertionResults[0].errored).toBe(true);
    expect(outcome.assertionResults[0].message).toBe("Missing deterministic evaluation result");
    expect(outcome.assertionResults[1].skipped).toBe(true);
    expect(outcome.assertionResults[1].reason).toContain("deterministic assertion errored");
  });
});
