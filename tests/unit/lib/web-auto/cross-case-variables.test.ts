import { describe, expect, it, vi, beforeEach } from "vitest";

const mockRunWebAutoMcp = vi.fn();
const mockRunWebAutoEvaluation = vi.fn();
const mockPublish = vi.fn();
const mockRecordRunNotification = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/web-auto/runner-mcp", () => ({
  runWebAutoMcp: (...args: unknown[]) => mockRunWebAutoMcp(...args),
}));

vi.mock("@/lib/web-auto/evaluator", () => ({
  runWebAutoEvaluation: (...args: unknown[]) => mockRunWebAutoEvaluation(...args),
}));

vi.mock("@/lib/runner/event-bus", () => ({
  publish: (...args: unknown[]) => mockPublish(...args),
}));

vi.mock("@/lib/runner/notifications", () => ({
  recordRunNotification: (...args: unknown[]) => mockRecordRunNotification(...args),
}));

const mockGetWebAutoSuiteById = vi.fn();
const mockListEnabledWebAutoCasesForRun = vi.fn();
const mockCreateWebAutoRun = vi.fn();
const mockFinalizeWebAutoRun = vi.fn();
const mockWriteWebAutoCaseResult = vi.fn();

vi.mock("@/lib/web-auto/storage", () => ({
  getWebAutoSuiteById: (...args: unknown[]) => mockGetWebAutoSuiteById(...args),
  listEnabledWebAutoCasesForRun: (...args: unknown[]) =>
    mockListEnabledWebAutoCasesForRun(...args),
  createWebAutoRun: (...args: unknown[]) => mockCreateWebAutoRun(...args),
  finalizeWebAutoRun: (...args: unknown[]) => mockFinalizeWebAutoRun(...args),
  writeWebAutoCaseResult: (...args: unknown[]) => mockWriteWebAutoCaseResult(...args),
}));

const {
  runWebAutoCase,
  extractWebAutoStructuredData,
  startWebAutoSuiteRun,
} = await import("@/lib/web-auto/orchestrator");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("extractWebAutoStructuredData", () => {
  it("unwraps result object and merges page metadata", () => {
    const output = {
      result: { orderId: "ORD-123", amount: 99 },
      page: { url: "https://example.com/checkout", title: "Checkout" },
    };
    const structured = extractWebAutoStructuredData(output);
    expect(structured).toEqual({
      orderId: "ORD-123",
      amount: 99,
      page: { url: "https://example.com/checkout", title: "Checkout" },
    });
  });

  it("returns primitive or array result directly", () => {
    expect(extractWebAutoStructuredData({ result: "token-abc" })).toBe("token-abc");
    expect(extractWebAutoStructuredData({ result: [1, 2, 3] })).toEqual([1, 2, 3]);
  });

  it("handles fallback and non-wrapper outputs safely", () => {
    expect(extractWebAutoStructuredData({ customKey: "foo" })).toEqual({ customKey: "foo" });
    expect(extractWebAutoStructuredData(null)).toEqual({});
    expect(extractWebAutoStructuredData(undefined)).toEqual({});
  });
});

describe("runWebAutoCase - cross-case variable referencing", () => {
  const dummySuite = {
    id: "suite-1",
    name: "Web Auto Suite",
    mcpServerId: "mcp-server-1",
    evaluatorAgentId: null,
    variables: null,
    timeoutSec: 60,
  } as unknown as import("@/lib/db/schema").WebAutoSuiteEntity;

  it("interpolates {{cases.010.output.token}} and {{$uuid}} into script content", async () => {
    let capturedScript = "";
    mockRunWebAutoMcp.mockImplementationOnce(async ({ scriptContent }) => {
      capturedScript = scriptContent;
      return {
        status: "success",
        executionOutput: { result: { success: true } },
        error: null,
        durationMs: 100,
      };
    });

    const suiteContext = {
      "010": {
        input: {},
        output: { token: "auth-token-999" },
      },
    };

    const outcome = await runWebAutoCase({
      caseId: 2,
      suiteId: "suite-1",
      suite: dummySuite,
      case: {
        id: 2,
        name: "020_use_token",
        input: {
          script: `async (page) => {
            const token = "{{cases.010.output.token}}";
            const reqId = "{{$uuid}}";
            return { token, reqId };
          }`,
        },
        assertions: [],
      } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
      ownerId: "user-1",
      suiteContext,
    });

    expect(outcome.status).toBe("passed");
    expect(capturedScript).toContain("auth-token-999");
    expect(capturedScript).not.toContain("{{cases.010.output.token}}");
    // Verify generator $uuid was resolved to a uuid regex match
    expect(capturedScript).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("injects cases object into IIFE scope and allows js_expression assertions to access cases", async () => {
    mockRunWebAutoMcp.mockImplementationOnce(async ({ scriptContent }) => {
      // Verify cases object is frozen in the IIFE header
      expect(scriptContent).toContain("const cases = Object.freeze(");
      expect(scriptContent).toContain('"token":"auth-token-999"');
      return {
        status: "success",
        executionOutput: { result: { currentToken: "auth-token-999" } },
        error: null,
        durationMs: 120,
      };
    });

    const suiteContext = {
      "010": {
        input: {},
        output: { token: "auth-token-999" },
      },
    };

    const outcome = await runWebAutoCase({
      caseId: 2,
      suiteId: "suite-1",
      suite: dummySuite,
      case: {
        id: 2,
        name: "020_verify_token",
        input: {
          script: "async (page) => ({ currentToken: 'auth-token-999' })",
        },
        assertions: [
          {
            type: "js_expression",
            expression: "result.currentToken === cases['010'].output.token",
          },
        ],
      } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
      ownerId: "user-1",
      suiteContext,
    });

    expect(outcome.status).toBe("passed");
    expect(outcome.assertionResults[0].ok).toBe(true);
  });
});

describe("Suite execution loop - sequential cross-case output propagation", () => {
  const dummySuite = {
    id: "suite-suite-loop",
    name: "Sequential Web Auto Suite",
    mcpServerId: "mcp-server-1",
    evaluatorAgentId: null,
    variables: null,
    timeoutSec: 60,
  } as unknown as import("@/lib/db/schema").WebAutoSuiteEntity;

  it("propagates output from 010_create to 020_consume across the suite run", async () => {
    mockGetWebAutoSuiteById.mockResolvedValueOnce(dummySuite);
    mockCreateWebAutoRun.mockResolvedValueOnce({ id: "run-seq-1" });
    mockFinalizeWebAutoRun.mockResolvedValueOnce(undefined);

    const cases = [
      {
        id: 10,
        name: "010_create_order",
        enabled: true,
        input: {
          script: "async (page) => ({ orderId: 'ORD-777' })",
        },
        assertions: [],
      },
      {
        id: 20,
        name: "020_check_order",
        enabled: true,
        input: {
          script: `async (page) => {
            const id = "{{cases.010.output.orderId}}";
            return { received: id };
          }`,
        },
        assertions: [
          {
            type: "js_expression",
            expression: "result.received === 'ORD-777'",
          },
        ],
      },
    ];

    mockListEnabledWebAutoCasesForRun.mockResolvedValueOnce(cases);

    const capturedScripts: string[] = [];
    mockRunWebAutoMcp.mockImplementation(async ({ scriptContent }) => {
      capturedScripts.push(scriptContent);
      if (capturedScripts.length === 1) {
        return {
          status: "success",
          executionOutput: { result: { orderId: "ORD-777" } },
          error: null,
          durationMs: 50,
        };
      }
      return {
        status: "success",
        executionOutput: { result: { received: "ORD-777" } },
        error: null,
        durationMs: 60,
      };
    });

    const result = await startWebAutoSuiteRun({
      suiteId: "suite-suite-loop",
      ownerId: "user-1",
    });

    expect(result.runId).toBe("run-seq-1");
    expect(result.totalCount).toBe(2);

    // Allow background loop to execute
    await new Promise((r) => setTimeout(r, 50));

    expect(capturedScripts).toHaveLength(2);
    // Case 020 received interpolated orderId from Case 010
    expect(capturedScripts[1]).toContain("ORD-777");
    expect(capturedScripts[1]).not.toContain("{{cases.010.output.orderId}}");

    // Verify both cases were recorded
    expect(mockWriteWebAutoCaseResult).toHaveBeenCalledTimes(2);
    expect(mockFinalizeWebAutoRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-seq-1",
        status: "passed",
        passedCount: 2,
        failedCount: 0,
        erroredCount: 0,
      }),
    );
  });
});
