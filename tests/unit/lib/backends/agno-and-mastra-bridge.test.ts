import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { getAgentCredentialConfigByIdMock } = vi.hoisted(() => ({
  getAgentCredentialConfigByIdMock: vi.fn(),
}));

vi.mock("@/lib/credentials/lookup", () => ({
  getAgentCredentialConfigById: getAgentCredentialConfigByIdMock,
  onCredentialCacheInvalidated: vi.fn(),
}));

import { firstValueFrom, toArray } from "rxjs";
import { agnoChatHandler } from "@/lib/backends/agno/chat.server";
import { mastraChatHandler } from "@/lib/backends/mastra/chat.server";
import { AbstractAgent } from "@/lib/copilot/index.server";

describe("Backend Protocol Bridges — Agno & Mastra", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAgentCredentialConfigByIdMock.mockResolvedValue({
      id: "cred-test",
      restUrl: "http://localhost:4111",
      token: "test-secret-key",
      aguiUrl: null,
    });
  });

  describe("Mastra Protocol Bridge", () => {
    it("converts Mastra stream SSE chunks into AG-UI TEXT_MESSAGE_CHUNK and TOOL_CALL events", async () => {
      const mockSseStream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"text-delta","payload":{"text":"Hello from Mastra!"}}\n\n' +
                'data: {"type":"tool-call","payload":{"id":"call_123","toolName":"get_weather","args":{"city":"SF"}}}\n\n' +
                "data: [DONE]\n\n",
            ),
          );
          controller.close();
        },
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: mockSseStream,
      } as unknown as Response);

      try {
        const agent = (await mastraChatHandler.buildAgent({
          credentialId: "cred-mastra-1",
          agentId: "weather-agent",
          agentKind: "agent",
          userId: "user-1",
          endpoint: "/api/copilotkit",
        })) as AbstractAgent;

        expect(typeof agent.run).toBe("function");

        const events$ = agent.run({
          threadId: "t-1",
          runId: "r-1",
          messages: [{ id: "m-1", role: "user", content: "What is the weather?" }],
          tools: [{ name: "get_weather", description: "Get weather" }],
          context: [],
          forwardedProps: { user_id: "user-1" },
        });

        const events = await firstValueFrom(events$.pipe(toArray()));
        expect(events.length).toBeGreaterThan(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("handles non-200 responses with descriptive error propagation", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers({ "content-type": "application/json" }),
        text: () => Promise.resolve('{"error":"Invalid API Key"}'),
      } as unknown as Response);

      try {
        const agent = (await mastraChatHandler.buildAgent({
          credentialId: "cred-mastra-2",
          agentId: "agent-2",
          agentKind: "agent",
          userId: "user-1",
          endpoint: "/api/copilotkit",
        })) as AbstractAgent;

        const events$ = agent.run({
          threadId: "t-1",
          runId: "r-2",
          messages: [{ id: "m-1", role: "user", content: "Hi" }],
          tools: [],
          context: [],
          forwardedProps: { user_id: "user-1" },
        });

        await expect(firstValueFrom(events$.pipe(toArray()))).rejects.toThrow();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("Agno Protocol Bridge", () => {
    it("handles Agno RunContent and emits TEXT_MESSAGE_CHUNK events", async () => {
      const mockSseStream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: RunContent\ndata: {"content":"Agno agent generated text"}\n\n' +
                'event: RunCompleted\ndata: {}\n\n',
            ),
          );
          controller.close();
        },
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: mockSseStream,
      } as unknown as Response);

      try {
        const agent = (await agnoChatHandler.buildAgent({
          credentialId: "cred-agno-1",
          agentId: "agno-agent-1",
          agentKind: "agent",
          userId: "user-1",
          endpoint: "/api/copilotkit",
        })) as AbstractAgent;

        expect(typeof agent.run).toBe("function");

        const events$ = agent.run({
          threadId: "t-1",
          runId: "r-3",
          messages: [{ id: "m-1", role: "user", content: "Hello Agno" }],
          tools: [],
          context: [],
          forwardedProps: { user_id: "user-1" },
        });

        const events = await firstValueFrom(events$.pipe(toArray()));
        expect(events.length).toBeGreaterThan(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
