import { describe, it, expect } from "vitest";
import { validateUniversalAssertionsConfig } from "@/components/main-panels/common/UniversalAssertionsEditor";
import type { AssertionSpec } from "@/lib/assertions";

describe("UniversalAssertionsEditor - validateUniversalAssertionsConfig", () => {
  it("rejects text_match assertion without scope in evaluation mode", () => {
    const assertions: AssertionSpec[] = [
      {
        type: "text_match",
        operator: "contains",
        expected: "forbidden term",
      },
    ];

    const err = validateUniversalAssertionsConfig("evaluation", assertions);
    expect(err).toContain("requires scope");
  });

  it("rejects text_match assertion with turn scope but missing or invalid turn number in evaluation mode", () => {
    const assertionsMissingTurn: AssertionSpec[] = [
      {
        type: "text_match",
        operator: "contains",
        expected: "must arrive",
        scope: "turn",
      },
    ];
    expect(validateUniversalAssertionsConfig("evaluation", assertionsMissingTurn)).toContain(
      "requires a valid turn number",
    );

    const assertionsZeroTurn: AssertionSpec[] = [
      {
        type: "text_match",
        operator: "contains",
        expected: "must arrive",
        scope: "turn",
        turn: 0,
      },
    ];
    expect(validateUniversalAssertionsConfig("evaluation", assertionsZeroTurn)).toContain(
      "requires a valid turn number",
    );
  });

  it("accepts valid text_match assertions with explicit scopes in evaluation mode", () => {
    const assertions: AssertionSpec[] = [
      {
        type: "text_match",
        operator: "contains",
        expected: "first turn output",
        scope: "turn",
        turn: 1,
      },
      {
        type: "text_match",
        operator: "not_contains",
        expected: "error 500",
        scope: "all_responses",
      },
      {
        type: "text_match",
        operator: "matches",
        expected: "^Success",
        scope: "final_response",
      },
    ];

    const err = validateUniversalAssertionsConfig("evaluation", assertions);
    expect(err).toBeNull();
  });

  it("permits text_match assertions without scope in verification and web-auto modes", () => {
    const assertions: AssertionSpec[] = [
      {
        type: "text_match",
        operator: "contains",
        expected: "done",
      },
    ];

    expect(validateUniversalAssertionsConfig("verification", assertions)).toBeNull();
    expect(validateUniversalAssertionsConfig("web-auto", assertions)).toBeNull();
  });
});
