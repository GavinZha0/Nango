import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { getEnabledObservabilityCredentialMock } = vi.hoisted(() => ({
  getEnabledObservabilityCredentialMock: vi.fn(),
}));

vi.mock("@/lib/credentials/lookup", () => ({
  getEnabledObservabilityCredential: getEnabledObservabilityCredentialMock,
  onCredentialCacheInvalidated: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  getConfig: vi.fn().mockReturnValue("builtin,frontend,proxy_errors"),
}));

const { langfuseTraceMock, langfuseInstanceMock } = vi.hoisted(() => {
  const traceMock = {
    update: vi.fn(),
    event: vi.fn(),
    span: vi.fn(),
  };
  return {
    langfuseTraceMock: traceMock,
    langfuseInstanceMock: {
      trace: vi.fn().mockReturnValue(traceMock),
      flushAsync: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock("langfuse", () => {
  return {
    Langfuse: function MockLangfuse() {
      return langfuseInstanceMock;
    },
  };
});

import {
  withTrace,
  flushLangfuse,
  invalidateLangfuseClient,
} from "@/lib/observability/langfuse";

describe("Langfuse Observability — Fail-Open & Robustness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateLangfuseClient();
  });

  describe("Fail-Open When Tracing Is Unavailable", () => {
    it("runs fn(null) cleanly when no observability credential exists", async () => {
      getEnabledObservabilityCredentialMock.mockResolvedValue(null);

      const result = await withTrace(
        { target: "builtin", name: "test-agent-run" },
        async (trace) => {
          expect(trace).toBeNull();
          return "execution-success";
        },
      );

      expect(result).toBe("execution-success");
      expect(langfuseInstanceMock.trace).not.toHaveBeenCalled();
    });

    it("runs fn(null) when credential is missing publicKey/secretKey", async () => {
      getEnabledObservabilityCredentialMock.mockResolvedValue({
        id: "cred-1",
        provider: "langfuse",
        publicKey: "",
        secretKey: "",
      });

      const result = await withTrace(
        { target: "builtin", name: "test-agent-run" },
        async (trace) => {
          expect(trace).toBeNull();
          return "fallback-success";
        },
      );

      expect(result).toBe("fallback-success");
      expect(langfuseInstanceMock.trace).not.toHaveBeenCalled();
    });
  });

  describe("Trace Lifecycle on Active Credential", () => {
    beforeEach(() => {
      getEnabledObservabilityCredentialMock.mockResolvedValue({
        id: "cred-langfuse",
        provider: "langfuse",
        publicKey: "pk-lf-test",
        secretKey: "sk-lf-test",
        host: "https://cloud.langfuse.com",
      });
    });

    it("starts trace, updates duration on success, and returns result", async () => {
      const result = await withTrace(
        {
          target: "builtin",
          name: "successful-run",
          userId: "user-123",
          sessionId: "sess-456",
          tags: ["agent:supervisor"],
        },
        async (trace) => {
          expect(trace).toBe(langfuseTraceMock);
          return { data: "ok" };
        },
      );

      expect(result).toEqual({ data: "ok" });
      expect(langfuseInstanceMock.trace).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "successful-run",
          userId: "user-123",
          sessionId: "sess-456",
        }),
      );
      expect(langfuseTraceMock.update).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            durationMs: expect.any(Number),
          }),
        }),
      );
    });

    it("records error event on failure and re-throws original error", async () => {
      const testError = new Error("LLM provider rate limited");

      await expect(
        withTrace(
          {
            target: "builtin",
            name: "failing-run",
            tags: ["agent:test"],
          },
          async () => {
            throw testError;
          },
        ),
      ).rejects.toThrow("LLM provider rate limited");

      expect(langfuseTraceMock.update).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: ["agent:test", "error"],
          output: { error: "LLM provider rate limited" },
        }),
      );

      expect(langfuseTraceMock.event).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "error",
          level: "ERROR",
          statusMessage: "LLM provider rate limited",
        }),
      );
    });

    it("handles flushLangfuse safely even if upstream flush fails", async () => {
      // Trigger client init
      await withTrace({ target: "builtin", name: "init-trace" }, async () => "ok");

      langfuseInstanceMock.flushAsync.mockRejectedValueOnce(new Error("Network timeout"));

      // Should not throw
      await expect(flushLangfuse()).resolves.toBeUndefined();
    });
  });
});
