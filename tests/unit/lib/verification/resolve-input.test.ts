import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { resolveInput, substituteInputTemplates, normalizeCaseName } = await import("@/lib/verification/resolve-input");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("resolveInput - generators", () => {
  it("expands {{$uuid}} to a v4 uuid string", () => {
    const out = resolveInput({ requestId: "{{$uuid}}" });
    expect(typeof out.requestId).toBe("string");
    expect(out.requestId as string).toMatch(UUID_RE);
  });
});

describe("substituteInputTemplates - assertion expected", () => {
  it("substitutes {{input.<path>}} against the resolved input", () => {
    const input = { requestId: "abc-123" };
    const result = substituteInputTemplates("{{input.requestId}}", input);
    expect(result).toBe("abc-123");
  });

  it("trims external spaces and performs exact substitution when value is wrapped in spaces and braces", () => {
    const input = { query: "uuid生成" };
    const result = substituteInputTemplates("  {{input.query}}  ", input);
    expect(result).toBe("uuid生成");
  });
});

describe("normalizeCaseName", () => {
  it("normalizes spaces and dashes to single underscores", () => {
    expect(normalizeCaseName("Create  User - Test")).toBe("create_user_test");
    expect(normalizeCaseName("  - My Awesome Tool...  ")).toBe("my_awesome_tool");
    expect(normalizeCaseName("get_user")).toBe("get_user");
  });
});

describe("resolveInput & substituteInputTemplates with suite context", () => {
  it("resolves variables from suite context cases", () => {
    const input = { userId: "{{cases.create_user.output.id}}", token: "bearer {{cases.login.output.token}}" };
    const context = {
      cases: {
        create_user: {
          input: {},
          output: { id: "user-123" }
        },
        login: {
          input: {},
          output: { token: "secret-token" }
        }
      }
    };
    const out = resolveInput(input, context);
    expect(out.userId).toBe("user-123");
    expect(out.token).toBe("bearer secret-token");
  });

  it("substitutes templates using suite context in assertions expected", () => {
    const context = {
      cases: {
        create_user: {
          input: {},
          output: { id: "user-123" }
        }
      }
    };
    const res = substituteInputTemplates("{{cases.create_user.output.id}}", {}, context);
    expect(res).toBe("user-123");
  });
});