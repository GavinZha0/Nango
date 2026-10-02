import { describe, it, expect } from "vitest";

import { registerCaseInSuiteContext } from "@/lib/testing/suite-context";
import { resolveInput, substituteInputTemplates } from "@/lib/assertions";

describe("registerCaseInSuiteContext", () => {
  it("registers case data under normalized case name and numeric prefix alias", () => {
    const context: Record<string, unknown> = {};
    registerCaseInSuiteContext(context, "010_create_user", {
      input: { username: "alice" },
      output: { id: "user-123", token: "jwt-xyz" },
    });

    const expectedData = {
      input: { username: "alice" },
      output: { id: "user-123", token: "jwt-xyz" },
    };

    expect(context["010_create_user"]).toEqual(expectedData);
    expect(context["010"]).toEqual(expectedData);
  });

  it("registers non-prefixed cases under normalized name only", () => {
    const context: Record<string, unknown> = {};
    registerCaseInSuiteContext(context, "Setup Environment", {
      input: { env: "test" },
      output: { ready: true },
    });

    expect(context["setup_environment"]).toEqual({
      input: { env: "test" },
      output: { ready: true },
    });
    expect(Object.keys(context)).toEqual(["setup_environment"]);
  });

  it("defaults missing input or output to empty objects while preserving valid falsy output values", () => {
    const context: Record<string, unknown> = {};
    registerCaseInSuiteContext(context, "020_check_flag", {
      output: false,
    });

    expect(context["020"]).toEqual({
      input: {},
      output: false,
    });

    registerCaseInSuiteContext(context, "030_empty_case", {});
    expect(context["030"]).toEqual({
      input: {},
      output: {},
    });
  });

  it("handles empty or whitespace-only case names gracefully without throwing", () => {
    const context: Record<string, unknown> = {};
    registerCaseInSuiteContext(context, "   ", { output: "foo" });
    expect(Object.keys(context)).toHaveLength(0);
  });

  it("enables resolveInput and substituteInputTemplates to reference registered case data", () => {
    const context: Record<string, unknown> = {};
    registerCaseInSuiteContext(context, "010_login", {
      input: { user: "admin" },
      output: { token: "secret-token-abc" },
    });

    const inputToResolve = {
      authHeader: "Bearer {{cases.010.output.token}}",
      userRef: "{{cases.010_login.input.user}}",
    };

    const resolved = resolveInput(inputToResolve, { cases: context });
    expect(resolved.authHeader).toBe("Bearer secret-token-abc");
    expect(resolved.userRef).toBe("admin");

    const templateResult = substituteInputTemplates(
      "{{cases.010.output.token}}",
      {},
      { cases: context },
    );
    expect(templateResult).toBe("secret-token-abc");
  });
});
