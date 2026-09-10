import { describe, it, expect } from "vitest";

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

  it("resolves variables using 3-digit numeric aliases identically to full case names", () => {
    const caseData010 = {
      input: { username: "alice" },
      output: { id: "user-010", token: "jwt-token-010" }
    };
    const caseData020 = {
      input: { profile: "dev" },
      output: { role: "admin" }
    };

    const context = {
      cases: {
        "010_create_user": caseData010,
        "010": caseData010, // Alias pointer
        "020_get_profile": caseData020,
        "020": caseData020, // Alias pointer
      }
    };

    const input = {
      userIdFromAlias: "{{cases.010.output.id}}",
      tokenFromAlias: "{{cases.010.output.token}}",
      userIdFromFullName: "{{cases.010_create_user.output.id}}",
      roleFromAlias: "{{cases.020.output.role}}",
    };

    const out = resolveInput(input, context);
    expect(out.userIdFromAlias).toBe("user-010");
    expect(out.tokenFromAlias).toBe("jwt-token-010");
    expect(out.userIdFromFullName).toBe("user-010");
    expect(out.roleFromAlias).toBe("admin");
  });

  it("strictly isolates suiteContext when transitioning across suites", () => {
    // Simulating Suite A execution
    let suiteContext: Record<string, unknown> = {
      "010_login": { output: { token: "token-suite-a" } },
      "010": { output: { token: "token-suite-a" } },
    };

    // Suite A case can access its own context
    const suiteAInput = { token: "{{cases.010.output.token}}" };
    expect(resolveInput(suiteAInput, { cases: suiteContext }).token).toBe("token-suite-a");

    // Transition to Suite B: reset context
    suiteContext = {};

    // Suite B case cannot see Suite A's variables
    const suiteBInput = { token: "{{cases.010.output.token}}" };
    const suiteBOut = resolveInput(suiteBInput, { cases: suiteContext });
    // Left untouched because cases.010 does not exist in Suite B
    expect(suiteBOut.token).toBe("{{cases.010.output.token}}");
  });
});

describe("computeNextCasePrefix helper", () => {
  it("defaults to 010_ when there are no cases", async () => {
    const { computeNextCasePrefix } = await import("@/lib/verification/resolve-input");
    expect(computeNextCasePrefix([])).toBe("010_");
  });

  it("defaults to 010_ when cases have no numeric prefix", async () => {
    const { computeNextCasePrefix } = await import("@/lib/verification/resolve-input");
    expect(computeNextCasePrefix([{ name: "login" }, { name: "get_user" }])).toBe("010_");
  });

  it("increments by 10 from the highest number and rounds up to next 10s boundary", async () => {
    const { computeNextCasePrefix } = await import("@/lib/verification/resolve-input");
    expect(computeNextCasePrefix([{ name: "010_login" }])).toBe("020_");
    expect(computeNextCasePrefix([{ name: "010_login" }, { name: "020_profile" }])).toBe("030_");
    // If there is an inserted case like 015, next is still 020
    expect(computeNextCasePrefix([{ name: "010_login" }, { name: "015_check" }])).toBe("020_");
    expect(computeNextCasePrefix([{ name: "025_check" }])).toBe("030_");
  });

  it("can be imported directly from @/lib/verification/prefix by client components", async () => {
    const { computeNextCasePrefix } = await import("@/lib/verification/prefix");
    expect(computeNextCasePrefix([])).toBe("010_");
    expect(computeNextCasePrefix([{ name: "010_test" }])).toBe("020_");
  });
});

describe("findUnresolvedTokens helper", () => {
  it("detects unresolved {{cases...}} and {{$...}} in payload trees", async () => {
    const { findUnresolvedTokens } = await import("@/lib/verification/resolve-input");

    const payload = {
      user: "{{cases.010.output.user}}",
      details: {
        token: "Bearer {{cases.020.output.token}}",
        valid: "normal text",
      },
      list: ["item", "{{$unknownGenerator}}"],
    };

    const unresolved = findUnresolvedTokens(payload);
    expect(unresolved).toEqual(
      expect.arrayContaining([
        "{{cases.010.output.user}}",
        "{{cases.020.output.token}}",
        "{{$unknownGenerator}}",
      ]),
    );
    expect(unresolved.length).toBe(3);
  });
});

describe("extractMcpStructuredData - strict MCP specification", () => {
  it("does NOT peel top-level 'result' when output is a business object", async () => {
    const { extractMcpStructuredData } = await import("@/lib/verification/resolve-input");

    // Case 1: Plain business output containing 'result' field (e.g. calculation)
    const businessPayload = { result: 42, data: "other" };
    const unwrapped = extractMcpStructuredData(businessPayload);
    // Must remain the full object, NOT stripped to 42!
    expect(unwrapped).toEqual({ result: 42, data: "other" });
  });

  it("extracts structuredContent without touching internal 'result' field", async () => {
    const { extractMcpStructuredData } = await import("@/lib/verification/resolve-input");

    const mcpEnvelope = {
      content: [{ type: "text", text: "..." }],
      isError: false,
      structuredContent: { result: 42, data: "other" },
    };
    const unwrapped = extractMcpStructuredData(mcpEnvelope);
    expect(unwrapped).toEqual({ result: 42, data: "other" });
  });

  it("extracts JSON content[0].text without stripping internal 'result' field", async () => {
    const { extractMcpStructuredData } = await import("@/lib/verification/resolve-input");

    const mcpEnvelope = {
      content: [{ type: "text", text: JSON.stringify({ result: 42, data: "other" }) }],
      isError: false,
    };
    const unwrapped = extractMcpStructuredData(mcpEnvelope);
    expect(unwrapped).toEqual({ result: 42, data: "other" });
  });

  it("returns raw payload as fallback when not structured", async () => {
    const { extractMcpStructuredData } = await import("@/lib/verification/resolve-input");

    const rawString = "raw text output";
    expect(extractMcpStructuredData(rawString)).toBe("raw text output");
  });

  it("promises fallback to raw MCP envelope when content is non-JSON plain text", async () => {
    const { extractMcpStructuredData } = await import("@/lib/verification/resolve-input");

    const mcpEnvelope = {
      content: [{ type: "text", text: "database connection timeout error" }],
      isError: true,
    };

    // 1. Unwrapping returns the entire original envelope intact
    const unwrapped = extractMcpStructuredData(mcpEnvelope);
    expect(unwrapped).toEqual(mcpEnvelope);

    // 2. Downstream case can access {{cases.010.output.content[0].text}} and {{cases.010.output.isError}}
    const context = {
      cases: {
        "010": {
          input: {},
          output: unwrapped,
        }
      }
    };

    const nextCaseInput = {
      errorMessage: "{{cases.010.output.content[0].text}}",
      hasError: "{{cases.010.output.isError}}",
    };

    const resolved = resolveInput(nextCaseInput, context);
    expect(resolved.errorMessage).toBe("database connection timeout error");
    expect(resolved.hasError).toBe(true);
  });

  it("preserves primitive bare values without data loss", async () => {
    const { extractMcpStructuredData } = await import("@/lib/verification/resolve-input");

    // Bare string
    expect(extractMcpStructuredData("hello world")).toBe("hello world");
    // Bare number
    expect(extractMcpStructuredData(42)).toBe(42);

    const context = {
      cases: {
        "010": { input: {}, output: extractMcpStructuredData("custom-token-str") },
        "020": { input: {}, output: extractMcpStructuredData(999) },
      }
    };

    const resolved = resolveInput(
      { str: "{{cases.010.output}}", num: "{{cases.020.output}}" },
      context
    );
    expect(resolved.str).toBe("custom-token-str");
    expect(resolved.num).toBe(999);
  });
});