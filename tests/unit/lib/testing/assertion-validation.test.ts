import { describe, it, expect } from "vitest";
import { normalizeAndValidateAssertions } from "@/lib/testing/assertion-validation";

describe("normalizeAndValidateAssertions", () => {
  it("returns empty array for empty or non-array inputs", () => {
    expect(normalizeAndValidateAssertions([], "Case 1")).toEqual([]);
    expect(normalizeAndValidateAssertions(null as unknown as unknown[], "Case 1")).toEqual([]);
  });

  it("auto-normalizes jsonpath expression alias to path", () => {
    const raw = [{ type: "jsonpath", expression: "$.data.id", operator: "==", expected: 123 }];
    const result = normalizeAndValidateAssertions(raw, "Case 1");
    expect(result).toEqual([
      { type: "jsonpath", expression: "$.data.id", path: "$.data.id", operator: "==", expected: 123 },
    ]);
  });

  it("auto-normalizes js alias to js_expression", () => {
    const raw = [{ type: "js", expression: "root.isError === false" }];
    const result = normalizeAndValidateAssertions(raw, "Case 1");
    expect(result).toEqual([
      { type: "js_expression", expression: "root.isError === false" },
    ]);
  });

  it("passes standard valid assertions without change", () => {
    const raw = [
      { type: "js_expression", expression: "root.status === 200" },
      { type: "metric", metric: "duration_s", operator: "<=", threshold: 10 },
      { type: "llm_judge", expectation: "Answer is clear and helpful" },
    ];
    const result = normalizeAndValidateAssertions(raw, "Case 1");
    expect(result.length).toBe(3);
    expect(result[0]?.type).toBe("js_expression");
    expect(result[1]?.type).toBe("metric");
    expect(result[2]?.type).toBe("llm_judge");
  });

  it("throws descriptive error when assertion type is unsupported or missing required fields", () => {
    const invalidType = [{ type: "invalid_type", foo: "bar" }];
    expect(() => normalizeAndValidateAssertions(invalidType, "Case 1")).toThrow(
      /Invalid assertion at index #0 in case 'Case 1'/,
    );

    const missingField = [{ type: "js_expression" }];
    expect(() => normalizeAndValidateAssertions(missingField, "Case 1")).toThrow(
      /Invalid assertion at index #0 in case 'Case 1'/,
    );
  });
});
