import { describe, it, expect, vi, beforeEach } from "vitest";

const runWebAutoMcpMock = vi.fn();
const runWebAutoEvaluationMock = vi.fn();
const getCredentialFieldsByIdMock = vi.fn();
const publishMock = vi.fn();
const recordRunNotificationMock = vi.fn();

vi.mock("@/lib/observability/logger", () => ({
  childLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("@/lib/runner/event-bus", () => ({
  publish: publishMock,
}));

vi.mock("@/lib/runner/notifications", () => ({
  recordRunNotification: recordRunNotificationMock,
}));

vi.mock("@/lib/credentials/lookup", () => ({
  getCredentialFieldsById: getCredentialFieldsByIdMock,
}));

vi.mock("@/lib/web-auto/runner-mcp", () => ({
  runWebAutoMcp: runWebAutoMcpMock,
}));

vi.mock("@/lib/web-auto/evaluator", () => ({
  runWebAutoEvaluation: runWebAutoEvaluationMock,
}));

vi.mock("@/lib/web-auto/storage", () => ({
  writeWebAutoCaseResult: vi.fn(),
  finalizeWebAutoRun: vi.fn(),
}));

const { runWebAutoCase } = await import("@/lib/web-auto/orchestrator");

describe("Web-Auto Orchestrator - Variable Resolution & Earliest Sanitization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseSuite = {
    id: "suite-1",
    parentId: null,
    name: "Login Test Suite",
    description: "Tests login flow",
    variables: {},
    enabled: true,
    visibility: "private",
    timeoutSec: 300,
    evaluatorAgentId: null,
    mcpServerId: "mcp-server-1",
    createdAt: new Date(),
    createdBy: "user-1",
    updatedAt: null,
    updatedBy: null,
  };

  const baseCase = {
    id: 1,
    suiteId: "suite-1",
    name: "Case 1",
    input: {
      script: "return { success: true, text: 'Hello' };",
    },
    assertions: [],
    enabled: true,
    createdAt: new Date(),
    createdBy: "user-1",
    updatedAt: null,
    updatedBy: null,
  };

  it("wraps script with IIFE and injects resolved variables into Playwright execution", async () => {
    getCredentialFieldsByIdMock.mockResolvedValueOnce({
      serviceType: "integration",
      provider: "testing",
      enabled: true,
      fields: {
        password: "SuperSecretPassword123!",
      },
    });

    runWebAutoMcpMock.mockResolvedValueOnce({
      status: "passed",
      executionOutput: { loggedIn: true },
      durationMs: 50,
      error: null,
    });

    const suite = {
      ...baseSuite,
      variables: {
        adminPass: {
          type: "credential",
          credentialId: "cred-uuid-1",
          field: "password",
        },
        targetUrl: {
          type: "literal",
          value: "https://example.com/login",
        },
      },
    };

    const outcome = await runWebAutoCase({
      caseId: 1,
      suiteId: "suite-1",
      suite,
      case: baseCase,
      ownerId: "user-1",
    });

    expect(outcome.status).toBe("passed");
    expect(runWebAutoMcpMock).toHaveBeenCalledTimes(1);
    const mcpCallArg = runWebAutoMcpMock.mock.calls[0][0];
    expect(mcpCallArg.mcpServerId).toBe("mcp-server-1");
    // Verify IIFE structure
    expect(mcpCallArg.scriptContent).toContain("(() => {");
    expect(mcpCallArg.scriptContent).toContain(
      'const variables = Object.freeze({"adminPass":"SuperSecretPassword123!","targetUrl":"https://example.com/login"});',
    );
    expect(mcpCallArg.scriptContent).toContain(
      "return (return { success: true, text: 'Hello' };);",
    );
    expect(mcpCallArg.scriptContent).toContain("})()");
  });

  it("applies Earliest Sanitization to executionOutput before downstream assertion & verdict", async () => {
    getCredentialFieldsByIdMock.mockResolvedValueOnce({
      serviceType: "integration",
      provider: "testing",
      enabled: true,
      fields: {
        password: "SuperSecretPassword123!",
      },
    });

    // MCP returns output that echoes the secret password
    runWebAutoMcpMock.mockResolvedValueOnce({
      status: "passed",
      executionOutput: {
        welcomeMessage: "Welcome! Password used: SuperSecretPassword123!",
        details: {
          nestedToken: "Bearer SuperSecretPassword123!",
        },
      },
      durationMs: 40,
      error: null,
    });

    const suite = {
      ...baseSuite,
      variables: {
        adminPass: {
          type: "credential",
          credentialId: "cred-uuid-1",
          field: "password",
        },
      },
    };

    const outcome = await runWebAutoCase({
      caseId: 1,
      suiteId: "suite-1",
      suite,
      case: baseCase,
      ownerId: "user-1",
    });

    expect(outcome.status).toBe("passed");
    // executionOutput must be thoroughly redacted with DEFAULT_MASK (******)
    expect(outcome.executionOutput).toEqual({
      welcomeMessage: "Welcome! Password used: ******",
      details: {
        nestedToken: "Bearer ******",
      },
    });
  });

  it("applies Earliest Sanitization to error messages and stack traces on execution failure", async () => {
    getCredentialFieldsByIdMock.mockResolvedValueOnce({
      serviceType: "integration",
      provider: "testing",
      enabled: true,
      fields: {
        apiKey: "api_key_secret_9999",
      },
    });

    runWebAutoMcpMock.mockResolvedValueOnce({
      status: "failed",
      executionOutput: null,
      durationMs: 80,
      error: {
        source: "upstream",
        message: "Failed to authenticate with api_key_secret_9999 at https://api.example.com",
        stack: "Error: Failed with key api_key_secret_9999\n    at login.ts:12",
      },
    });

    const suite = {
      ...baseSuite,
      variables: {
        token: {
          type: "credential",
          credentialId: "cred-uuid-1",
          field: "apiKey",
        },
      },
    };

    const outcome = await runWebAutoCase({
      caseId: 1,
      suiteId: "suite-1",
      suite,
      case: baseCase,
      ownerId: "user-1",
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toBe(
      "Failed to authenticate with ****** at https://api.example.com",
    );
    expect((outcome.error as unknown as Record<string, unknown>)?.stack).toBe(
      "Error: Failed with key ******\n    at login.ts:12",
    );
    expect(outcome.assertionResults[0]?.message).toBe(
      "Failed to authenticate with ****** at https://api.example.com",
    );
  });

  it("evaluates assertions with literalVariables only (preventing credential leakage)", async () => {
    getCredentialFieldsByIdMock.mockResolvedValueOnce({
      serviceType: "integration",
      provider: "testing",
      enabled: true,
      fields: {
        password: "SuperSecretPassword123!",
      },
    });

    runWebAutoMcpMock.mockResolvedValueOnce({
      status: "passed",
      executionOutput: {
        domain: "auth.example.com",
      },
      durationMs: 30,
      error: null,
    });

    const caseWithAssertion = {
      ...baseCase,
      assertions: [
        {
          type: "js_expression",
          expression: "result.domain === variables.expectedDomain && variables.adminPass === undefined",
        },
      ],
    };

    const suite = {
      ...baseSuite,
      variables: {
        adminPass: {
          type: "credential",
          credentialId: "cred-uuid-1",
          field: "password",
        },
        expectedDomain: {
          type: "literal",
          value: "auth.example.com",
        },
      },
    };

    const outcome = await runWebAutoCase({
      caseId: 1,
      suiteId: "suite-1",
      suite,
      case: caseWithAssertion,
      ownerId: "user-1",
    });

    // Assertion succeeds because:
    // 1. variables.expectedDomain is available from literalVariables
    // 2. variables.adminPass is strictly UNDEFINED in assertions (credential isolation)
    expect(outcome.status).toBe("passed");
    expect(outcome.verdict.deterministic.passed).toBe(true);
    expect(outcome.assertionResults[0]?.ok).toBe(true);
  });

  it("sanitizes LLM evaluator feedback before persisting and returning verdict", async () => {
    getCredentialFieldsByIdMock.mockResolvedValueOnce({
      serviceType: "integration",
      provider: "testing",
      enabled: true,
      fields: {
        secretToken: "xyz_token_secret_888",
      },
    });

    runWebAutoMcpMock.mockResolvedValueOnce({
      status: "passed",
      executionOutput: { banner: "Logged in" },
      durationMs: 50,
      error: null,
    });

    runWebAutoEvaluationMock.mockResolvedValueOnce({
      passed: true,
      score: 95,
      feedback: "The page correctly displayed banner using xyz_token_secret_888.",
      expectationResults: [
        {
          index: 0,
          passed: true,
          score: 95,
          reason: "Verified banner presence with xyz_token_secret_888.",
        },
      ],
      rawResponse: "raw xyz_token_secret_888",
    });

    const caseWithLlmAssertion = {
      ...baseCase,
      assertions: [
        {
          type: "llm_expectation",
          expectation: "Banner should indicate logged in status",
        },
      ],
    };

    const suite = {
      ...baseSuite,
      evaluatorAgentId: "eval-agent-1",
      variables: {
        tok: {
          type: "credential",
          credentialId: "cred-uuid-1",
          field: "secretToken",
        },
      },
    };

    const outcome = await runWebAutoCase({
      caseId: 1,
      suiteId: "suite-1",
      suite,
      case: caseWithLlmAssertion,
      ownerId: "user-1",
    });

    expect(outcome.status).toBe("passed");
    // LLM feedback and reason must have secrets redacted
    expect(outcome.verdict.llm?.feedback).toBe(
      "The page correctly displayed banner using ******.",
    );
    expect(outcome.verdict.llm?.expectationResults[0]?.reason).toBe(
      "Verified banner presence with ******.",
    );
  });

  it("fails closed when credential resolution errors without invoking MCP runner", async () => {
    getCredentialFieldsByIdMock.mockResolvedValueOnce(null); // Disabled or non-existent credential

    const suite = {
      ...baseSuite,
      variables: {
        adminPass: {
          type: "credential",
          credentialId: "cred-disabled",
          field: "password",
        },
      },
    };

    const outcome = await runWebAutoCase({
      caseId: 1,
      suiteId: "suite-1",
      suite,
      case: baseCase,
      ownerId: "user-1",
    });

    expect(outcome.status).toBe("errored");
    expect(outcome.error?.source).toBe("config");
    expect(outcome.error?.message).toContain("not found");
    // MCP runner was NEVER invoked
    expect(runWebAutoMcpMock).not.toHaveBeenCalled();
  });
});
