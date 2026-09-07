/**
 * Unit tests for src/lib/backends/runtime.server.ts — AG-UI runtime entry.
 *
 * Covers runWithAgents (assembly, inbound prompt scan, outbound SSE
 * redaction, error path) and the private trimHistoricalMessages helper
 * (exercised via trimMessages:true through runWithAgents).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";


// vi.hoisted ensures the mock factories (which run before imports) can
// reference the same mock instances we assert against in the test body.
const mocks = vi.hoisted(() => ({
  CopilotRuntimeMock: vi.fn(),
  createCopilotRuntimeHandlerMock: vi.fn(),
  handlerMock: vi.fn(),
  logMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  childLoggerMock: vi.fn(),
  scanIncomingPromptMock: vi.fn(),
  processChunkMock: vi.fn(),
  flushMock: vi.fn(),
  SseStreamRedactorMock: vi.fn(),
  recordInterceptionLogMock: vi.fn(),
  // Captures the onRedact callback passed to SseStreamRedactor so tests
  // can exercise the recordInterceptionLog + .catch branch (lines 201-212).
  capturedOnRedact: null as ((rule: { name: string }, snippet: string) => void) | null,
}));

vi.mock("@/lib/copilot/index.server", () => ({
  CopilotRuntime: mocks.CopilotRuntimeMock,
  createCopilotRuntimeHandler: mocks.createCopilotRuntimeHandlerMock,
}));

vi.mock("@/lib/observability/logger", () => ({
  childLogger: mocks.childLoggerMock,
}));

vi.mock("@/lib/agent-pipeline/input-safety", () => ({
  scanIncomingPrompt: mocks.scanIncomingPromptMock,
}));

vi.mock("@/lib/agent-pipeline/output-safety", () => ({
  SseStreamRedactor: mocks.SseStreamRedactorMock,
  DEFAULT_REDACTION_RULES: [],
}));

vi.mock("@/lib/agent-pipeline/guardrail-service", () => ({
  recordInterceptionLog: mocks.recordInterceptionLogMock,
}));

import { runWithAgents, type RunWithAgentsInput } from "@/lib/backends/runtime.server";
import type { AbstractAgent } from "@/lib/copilot/index.server";

const BASE_URL = "http://localhost:9300";

function makeRunUrl(agentId = "ag1"): string {
  return `${BASE_URL}/api/copilotkit/agent/${agentId}/run`;
}

function makeRequest(
  url: string,
  init: { method?: string; body?: unknown } = {},
): Request {
  const { method = "GET", body } = init;
  if (body !== undefined) {
    return new Request(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }
  return new Request(url, { method });
}

function makeInput(
  overrides: Partial<RunWithAgentsInput> = {},
): RunWithAgentsInput {
  return {
    agents: {},
    endpoint: "/api/copilotkit",
    trimMessages: false,
    entitySource: "backend",
    ...overrides,
  } as RunWithAgentsInput;
}

function agentMap(n: number): Record<string, AbstractAgent> {
  const m: Record<string, AbstractAgent> = {};
  for (let i = 0; i < n; i++) m[`agent-${i}`] = {} as AbstractAgent;
  return m;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.childLoggerMock.mockReturnValue(mocks.logMock);
  mocks.createCopilotRuntimeHandlerMock.mockReturnValue(mocks.handlerMock);
  // SseStreamRedactor is invoked with `new` in the source. A constructor
  // that returns an object causes `new` to yield that object, so this
  // mockImplementation works with `new SseStreamRedactor(...)`. We also
  // capture the onRedact callback so the SSE test can drive it.
  mocks.capturedOnRedact = null;
  mocks.SseStreamRedactorMock.mockImplementation(function (
    _rules: unknown,
    onRedact?: (rule: { name: string }, snippet: string) => void,
  ) {
    mocks.capturedOnRedact = onRedact ?? null;
    return { processChunk: mocks.processChunkMock, flush: mocks.flushMock };
  });
  mocks.scanIncomingPromptMock.mockResolvedValue({ action: "pass" });
  mocks.recordInterceptionLogMock.mockResolvedValue(undefined);
  // Default handler returns a plain non-SSE response.
  mocks.handlerMock.mockResolvedValue(new Response("ok", { status: 200 }));
  // Default redactor: pass-through, and drive the onRedact callback so
  // the recordInterceptionLog branch (lines 201-211) is exercised on
  // every SSE test.
  mocks.processChunkMock.mockImplementation((s: string) => {
    if (mocks.capturedOnRedact) {
      mocks.capturedOnRedact({ name: "test-rule" }, "leak-snippet");
    }
    return s;
  });
  mocks.flushMock.mockReturnValue("");
});

describe("RuntimeServerTest", () => {
  // ---------------------------------------------------------------------------
  // runWithAgents — runtime assembly
  // ---------------------------------------------------------------------------
  describe("runWithAgents — runtime assembly", () => {
    it("constructs CopilotRuntime with agents and calls handler, returning its Response", async () => {
      const agents = agentMap(1);
      const req = makeRequest(`${BASE_URL}/api/copilotkit/info`);
      const res = await runWithAgents(req, makeInput({ agents }));

      expect(mocks.CopilotRuntimeMock).toHaveBeenCalledTimes(1);
      const ctorArg = mocks.CopilotRuntimeMock.mock.calls[0][0] as Record<string, unknown>;
      expect(ctorArg.agents).toBe(agents);
      expect(mocks.createCopilotRuntimeHandlerMock).toHaveBeenCalledWith({
        runtime: mocks.CopilotRuntimeMock.mock.results[0].value,
        basePath: "/api/copilotkit",
      });
      expect(mocks.handlerMock).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    });


    it("assembles with multiple backend agents", async () => {
      const agents = agentMap(3);
      const req = makeRequest(`${BASE_URL}/api/copilotkit/info`);
      await runWithAgents(req, makeInput({ agents }));

      const ctorArg = mocks.CopilotRuntimeMock.mock.calls[0][0] as Record<string, unknown>;
      expect(Object.keys(ctorArg.agents as Record<string, unknown>)).toHaveLength(3);
    });

    it("passes runner to CopilotRuntime when provided", async () => {
      const runner = { id: "custom-runner" } as unknown as RunWithAgentsInput["runner"];
      const req = makeRequest(`${BASE_URL}/api/copilotkit/info`);
      await runWithAgents(req, makeInput({ runner }));

      const ctorArg = mocks.CopilotRuntimeMock.mock.calls[0][0] as Record<string, unknown>;
      expect(ctorArg.runner).toBe(runner);
    });

    it("omits runner from CopilotRuntime options when not provided", async () => {
      const req = makeRequest(`${BASE_URL}/api/copilotkit/info`);
      await runWithAgents(req, makeInput());

      const ctorArg = mocks.CopilotRuntimeMock.mock.calls[0][0] as Record<string, unknown>;
      expect(ctorArg.runner).toBeUndefined();
    });

    it("passes transcriptionService to CopilotRuntime when provided", async () => {
      const ts = { id: "ts" } as unknown as NonNullable<RunWithAgentsInput["transcriptionService"]>;
      const req = makeRequest(`${BASE_URL}/api/copilotkit/info`);
      await runWithAgents(req, makeInput({ transcriptionService: ts }));

      const ctorArg = mocks.CopilotRuntimeMock.mock.calls[0][0] as Record<string, unknown>;
      expect(ctorArg.transcriptionService).toBe(ts);
    });

    it("logs runtime_dispatch ok with status and duration on success", async () => {
      const req = makeRequest(`${BASE_URL}/api/copilotkit/info`);
      await runWithAgents(req, makeInput());

      expect(mocks.logMock.info).toHaveBeenCalledTimes(1);
      const logArg = mocks.logMock.info.mock.calls[0][0] as Record<string, unknown>;
      expect(logArg.event).toBe("runtime_dispatch");
      expect(logArg.status).toBe(200);
      expect(typeof logArg.durationMs).toBe("number");
    });

    it("rethrows and logs error when handler throws", async () => {
      const err = new Error("handler boom");
      mocks.handlerMock.mockRejectedValueOnce(err);
      const req = makeRequest(`${BASE_URL}/api/copilotkit/info`);

      await expect(runWithAgents(req, makeInput())).rejects.toThrow("handler boom");
      expect(mocks.logMock.error).toHaveBeenCalledTimes(1);
      const logArg = mocks.logMock.error.mock.calls[0][0] as Record<string, unknown>;
      expect(logArg.event).toBe("runtime_dispatch");
      expect((logArg.err as { message: string }).message).toBe("handler boom");
    });

    it("rethrows non-Error values and logs them as String", async () => {
      mocks.handlerMock.mockRejectedValueOnce("string error");
      const req = makeRequest(`${BASE_URL}/api/copilotkit/info`);

      await expect(runWithAgents(req, makeInput())).rejects.toBe("string error");
      const logArg = mocks.logMock.error.mock.calls[0][0] as Record<string, unknown>;
      expect(logArg.err).toBe("string error");
    });
  });

  // ---------------------------------------------------------------------------
  // runWithAgents — inbound prompt scan
  // ---------------------------------------------------------------------------
  describe("runWithAgents — inbound prompt scan", () => {
    it("does not scan on non-POST requests", async () => {
      const req = makeRequest(makeRunUrl(), { method: "GET" });
      await runWithAgents(req, makeInput());

      expect(mocks.scanIncomingPromptMock).not.toHaveBeenCalled();
    });

    it("does not scan when path does not match /agent/:id/run", async () => {
      const req = makeRequest(`${BASE_URL}/api/copilotkit/info`, {
        method: "POST",
        body: { messages: [{ role: "user", content: "hi" }] },
      });
      await runWithAgents(req, makeInput());

      expect(mocks.scanIncomingPromptMock).not.toHaveBeenCalled();
    });

    it("does not scan when no user message is present", async () => {
      const req = makeRequest(makeRunUrl(), {
        method: "POST",
        body: { messages: [{ role: "assistant", content: "hello" }] },
      });
      await runWithAgents(req, makeInput());

      expect(mocks.scanIncomingPromptMock).not.toHaveBeenCalled();
    });

    it("does not scan when last user message content is not a string", async () => {
      const req = makeRequest(makeRunUrl(), {
        method: "POST",
        body: { messages: [{ role: "user", content: { parts: ["x"] } }] },
      });
      await runWithAgents(req, makeInput());

      expect(mocks.scanIncomingPromptMock).not.toHaveBeenCalled();
    });

    it("scans and proceeds when scan returns pass", async () => {
      mocks.scanIncomingPromptMock.mockResolvedValueOnce({ action: "pass" });
      const req = makeRequest(makeRunUrl(), {
        method: "POST",
        body: { messages: [{ role: "user", content: "hello" }] },
      });
      const res = await runWithAgents(req, makeInput({ diag: { userId: "u1", runId: "r1", agentId: "a1" } }));

      expect(mocks.scanIncomingPromptMock).toHaveBeenCalledWith("hello", "u1", "r1", "a1");
      expect(mocks.handlerMock).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(200);
    });

    it("returns SSE block response when scan returns block", async () => {
      mocks.scanIncomingPromptMock.mockResolvedValueOnce({
        action: "block",
        message: "blocked by policy X",
      });
      const req = makeRequest(makeRunUrl(), {
        method: "POST",
        body: {
          threadId: "thread-123",
          messages: [{ role: "user", content: "bad prompt" }],
        },
      });
      const res = await runWithAgents(req, makeInput({ diag: { runId: "run-1" } }));

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("connection")).toBe("keep-alive");
      const text = await res.text();
      expect(text).toContain('"type":"RUN_STARTED"');
      expect(text).toContain('"threadId":"thread-123"');
      expect(text).toContain('"runId":"run-1"');
      expect(text).toContain('"type":"TEXT_MESSAGE_START"');
      expect(text).toContain('"role":"assistant"');
      expect(text).toContain('"type":"TEXT_MESSAGE_CONTENT"');
      expect(text).toContain("🚨 [Guardrails] blocked by policy X");
      expect(text).toContain('"type":"TEXT_MESSAGE_END"');
      expect(text).toContain('"type":"RUN_FINISHED"');
      // Handler is bypassed on block.
      expect(mocks.handlerMock).not.toHaveBeenCalled();
      expect(mocks.logMock.warn).toHaveBeenCalledWith(
        { event: "prompt_blocked" },
        "Incoming prompt blocked by guardrails",
      );
    });

    it("uses fallback runId/threadId in block response when diag and body lack them", async () => {
      mocks.scanIncomingPromptMock.mockResolvedValueOnce({
        action: "block",
        message: undefined,
      });
      const req = makeRequest(makeRunUrl(), {
        method: "POST",
        body: { messages: [{ role: "user", content: "bad" }] },
      });
      const res = await runWithAgents(req, makeInput());

      const text = await res.text();
      // Default message when scanResult.message is undefined.
      expect(text).toContain("Request blocked by safety policy.");
      // runId/threadId fallbacks start with the documented prefixes.
      expect(text).toMatch(/"runId":"run-\d+"/);
      expect(text).toMatch(/"threadId":"thread-\d+"/);
    });

    it("rebuilds request with redacted content when scan returns redact", async () => {
      mocks.scanIncomingPromptMock.mockResolvedValueOnce({
        action: "redact",
        result: "[REDACTED]",
      });
      const req = makeRequest(makeRunUrl(), {
        method: "POST",
        body: {
          messages: [
            { role: "assistant", content: "prev" },
            { role: "user", content: "my-secret" },
          ],
        },
      });
      await runWithAgents(req, makeInput());

      // The handler receives a request whose last user message content
      // has been replaced with the redaction result.
      const passedReq = mocks.handlerMock.mock.calls[0][0] as Request;
      const body = (await passedReq.clone().json()) as { messages: { content: string }[] };
      expect(body.messages[1].content).toBe("[REDACTED]");
      // Earlier message untouched.
      expect(body.messages[0].content).toBe("prev");
    });

    it("logs warn and continues when request body JSON parse fails", async () => {
      const req = makeRequest(makeRunUrl(), {
        method: "POST",
        body: "{not valid json",
      });
      const res = await runWithAgents(req, makeInput());

      expect(mocks.logMock.warn).toHaveBeenCalledTimes(1);
      const warnArgs = mocks.logMock.warn.mock.calls[0];
      expect(warnArgs[1]).toBe("Failed to parse request for prompt scanning");
      // Handler still called (scan skipped, trim skipped since parse fails).
      expect(mocks.handlerMock).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // runWithAgents — outbound SSE redaction
  // ---------------------------------------------------------------------------
  describe("runWithAgents — outbound SSE redaction", () => {
    it("wraps SSE response body through SseStreamRedactor and returns new Response", async () => {
      const sseBody = 'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"hello"}\n\n';
      mocks.handlerMock.mockResolvedValueOnce(
        new Response(sseBody, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          },
        }),
      );
      const req = makeRequest(`${BASE_URL}/api/copilotkit/info`);
      const res = await runWithAgents(req, makeInput());

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      // SseStreamRedactor was constructed with (null, onRedact).
      expect(mocks.SseStreamRedactorMock).toHaveBeenCalledTimes(1);
      expect(mocks.SseStreamRedactorMock.mock.calls[0][0]).toBeNull();
      // Consuming the stream drives processChunk + flush.
      await res.text();
      expect(mocks.processChunkMock).toHaveBeenCalled();
      expect(mocks.flushMock).toHaveBeenCalled();
    });

    it("returns non-SSE response directly without wrapping", async () => {
      mocks.handlerMock.mockResolvedValueOnce(
        new Response("plain", {
          status: 201,
          headers: { "Content-Type": "text/plain" },
        }),
      );
      const req = makeRequest(`${BASE_URL}/api/copilotkit/info`);
      const res = await runWithAgents(req, makeInput());

      expect(res.status).toBe(201);
      expect(await res.text()).toBe("plain");
      expect(mocks.SseStreamRedactorMock).not.toHaveBeenCalled();
    });

    it("returns response directly when body is null even with SSE content-type", async () => {
      mocks.handlerMock.mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
      const req = makeRequest(`${BASE_URL}/api/copilotkit/info`);
      const res = await runWithAgents(req, makeInput());

      expect(res.status).toBe(200);
      expect(mocks.SseStreamRedactorMock).not.toHaveBeenCalled();
    });

    it("invokes recordInterceptionLog via onRedact during SSE redaction", async () => {
      const sseBody = 'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"hi"}\n\n';
      mocks.handlerMock.mockResolvedValueOnce(
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
      const req = makeRequest(`${BASE_URL}/api/copilotkit/info`);
      const res = await runWithAgents(req, makeInput({
        diag: { runId: "r-redact", userId: "u-redact" },
      }));

      await res.text();
      // Drain microtasks so the async recordInterceptionLog resolves.
      await vi.waitFor(() => {
        expect(mocks.recordInterceptionLogMock).toHaveBeenCalled();
      });
      const callArg = mocks.recordInterceptionLogMock.mock.calls[0][0] as Record<string, unknown>;
      expect(callArg.runId).toBe("r-redact");
      expect(callArg.userId).toBe("u-redact");
      expect(callArg.stage).toBe("output");
      expect(callArg.category).toBe("output_redaction");
      expect(callArg.action).toBe("redact");
      expect(callArg.severity).toBe("high");
      expect(callArg.policyName).toBe("test-rule");
      expect((callArg.payload as { snippet: string }).snippet).toBe("leak-snippet");
    });

    it("logs error when recordInterceptionLog rejects inside onRedact (.catch branch)", async () => {
      mocks.recordInterceptionLogMock.mockRejectedValueOnce(new Error("db down"));
      const sseBody = 'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"hi"}\n\n';
      mocks.handlerMock.mockResolvedValueOnce(
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
      const req = makeRequest(`${BASE_URL}/api/copilotkit/info`);
      const res = await runWithAgents(req, makeInput());

      await res.text();
      await vi.waitFor(() => {
        expect(mocks.logMock.error).toHaveBeenCalledWith(
          expect.objectContaining({ err: expect.any(Error) }),
          "Failed to record redaction log",
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // runWithAgents — trimMessages (private trimHistoricalMessages)
  // ---------------------------------------------------------------------------
  describe("runWithAgents — trimMessages", () => {
    it("trims to last user message + everything after when trimMessages is true", async () => {
      const req = makeRequest(makeRunUrl(), {
        method: "POST",
        body: {
          messages: [
            { role: "user", content: "old1" },
            { role: "assistant", content: "resp1" },
            { role: "user", content: "old2" },
            { role: "assistant", content: "resp2" },
            { role: "user", content: "latest" },
            { role: "assistant", content: "after-latest" },
          ],
        },
      });
      await runWithAgents(req, makeInput({ trimMessages: true }));

      const passedReq = mocks.handlerMock.mock.calls[0][0] as Request;
      const body = (await passedReq.clone().json()) as { messages: { role: string; content: string }[] };
      // Trim keeps messages[4:] (last user at idx 4).
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe("user");
      expect(body.messages[0].content).toBe("latest");
      expect(body.messages[1].role).toBe("assistant");
      expect(body.messages[1].content).toBe("after-latest");
    });

    it("does not trim when trimMessages is false", async () => {
      const req = makeRequest(makeRunUrl(), {
        method: "POST",
        body: {
          messages: [
            { role: "user", content: "old" },
            { role: "assistant", content: "resp" },
            { role: "user", content: "latest" },
          ],
        },
      });
      await runWithAgents(req, makeInput({ trimMessages: false }));

      const passedReq = mocks.handlerMock.mock.calls[0][0] as Request;
      const body = (await passedReq.clone().json()) as { messages: unknown[] };
      expect(body.messages).toHaveLength(3);
    });

    it.each([
      {
        name: "method is not POST",
        makeReq: () => makeRequest(makeRunUrl(), { method: "GET" }),
        check: async () => {
          expect((mocks.handlerMock.mock.calls[0][0] as Request).method).toBe("GET");
        },
      },
      {
        name: "path does not match run pattern",
        makeReq: () => makeRequest(`${BASE_URL}/api/copilotkit/info`, {
          method: "POST",
          body: { messages: [{ role: "user", content: "x" }, { role: "user", content: "y" }] },
        }),
        check: async () => {
          const body = (await (mocks.handlerMock.mock.calls[0][0] as Request).clone().json()) as { messages: unknown[] };
          expect(body.messages).toHaveLength(2);
        },
      },
      {
        name: "messages is not an array",
        makeReq: () => makeRequest(makeRunUrl(), { method: "POST", body: { messages: "not-an-array" } }),
        check: async () => {
          const body = (await (mocks.handlerMock.mock.calls[0][0] as Request).clone().json()) as { messages: unknown };
          expect(body.messages).toBe("not-an-array");
        },
      },
      {
        name: "body is not an object",
        makeReq: () => makeRequest(makeRunUrl(), { method: "POST", body: "12345" }),
        check: async () => {},
      },
    ])("skips trim for non-run requests and malformed bodies ($name)", async ({ makeReq, check }) => {
      await runWithAgents(makeReq(), makeInput({ trimMessages: true }));
      expect(mocks.handlerMock).toHaveBeenCalledTimes(1);
      await check();
    });

    it("does not trim when body JSON parse fails", async () => {
      const req = makeRequest(makeRunUrl(), {
        method: "POST",
        body: "<<<broken",
      });
      await runWithAgents(req, makeInput({ trimMessages: true }));

      // Handler still called; trim short-circuits on parse failure.
      expect(mocks.handlerMock).toHaveBeenCalledTimes(1);
    });

    it("does not trim when messages array is empty", async () => {
      const req = makeRequest(makeRunUrl(), {
        method: "POST",
        body: { messages: [] },
      });
      await runWithAgents(req, makeInput({ trimMessages: true }));

      const passedReq = mocks.handlerMock.mock.calls[0][0] as Request;
      const body = (await passedReq.clone().json()) as { messages: unknown[] };
      expect(body.messages).toHaveLength(0);
    });


    it("does not trim when no user message exists (lastUserIdx stays -1)", async () => {
      const req = makeRequest(makeRunUrl(), {
        method: "POST",
        body: {
          messages: [
            { role: "assistant", content: "a1" },
            { role: "assistant", content: "a2" },
          ],
        },
      });
      await runWithAgents(req, makeInput({ trimMessages: true }));

      const passedReq = mocks.handlerMock.mock.calls[0][0] as Request;
      const body = (await passedReq.clone().json()) as { messages: unknown[] };
      expect(body.messages).toHaveLength(2);
    });

    it("does not trim when user message is the first message (lastUserIdx === 0)", async () => {
      const req = makeRequest(makeRunUrl(), {
        method: "POST",
        body: {
          messages: [
            { role: "user", content: "only" },
            { role: "assistant", content: "resp" },
          ],
        },
      });
      await runWithAgents(req, makeInput({ trimMessages: true }));

      const passedReq = mocks.handlerMock.mock.calls[0][0] as Request;
      const body = (await passedReq.clone().json()) as { messages: unknown[] };
      // lastUserIdx === 0 → `<= 0` early return, no trim.
      expect(body.messages).toHaveLength(2);
    });

    it("trims correctly when there are messages after the last user message", async () => {
      const req = makeRequest(makeRunUrl(), {
        method: "POST",
        body: {
          messages: [
            { role: "user", content: "u1" },
            { role: "assistant", content: "a1" },
            { role: "user", content: "u2" },
            { role: "tool", content: "t1" },
            { role: "assistant", content: "a2" },
          ],
        },
      });
      await runWithAgents(req, makeInput({ trimMessages: true }));

      const passedReq = mocks.handlerMock.mock.calls[0][0] as Request;
      const body = (await passedReq.clone().json()) as { messages: { content: string }[] };
      // lastUserIdx = 2 → slice(2) = [u2, t1, a2].
      expect(body.messages).toHaveLength(3);
      expect(body.messages[0].content).toBe("u2");
      expect(body.messages[1].content).toBe("t1");
      expect(body.messages[2].content).toBe("a2");
    });
  });

  // ---------------------------------------------------------------------------
  // runWithAgents — childLogger wiring
  // ---------------------------------------------------------------------------
  describe("runWithAgents — childLogger wiring", () => {
    it("passes entitySource and diag fields to childLogger", async () => {
      const req = makeRequest(makeRunUrl(), { method: "POST" });
      await runWithAgents(req, makeInput({
        entitySource: "builtin",
        diag: { agentId: "a1", credentialId: "c1", userId: "u1" },
      }));

      expect(mocks.childLoggerMock).toHaveBeenCalledTimes(1);
      const ctx = mocks.childLoggerMock.mock.calls[0][0] as Record<string, unknown>;
      expect(ctx.component).toBe("runtime-dispatch");
      expect(ctx.entitySource).toBe("builtin");
      expect(ctx.agentId).toBe("a1");
      expect(ctx.credentialId).toBe("c1");
      expect(ctx.userId).toBe("u1");
      expect(ctx.method).toBe("POST");
      expect(ctx.path).toBe("/api/copilotkit/agent/ag1/run");
    });
  });
});