import { describe, expect, it, vi } from "vitest";
import { resolveLanguageModel } from "@/lib/builtin-agents/model-resolver";
import type { AgentSpec } from "@/lib/builtin-agents/agent-spec";
import * as bridgeRuntimeKit from "@/lib/backends/bridge-runtime-kit.server";

function createMockSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    agentId: "test-agent-1",
    name: "Test Agent",
    role: null,
    modelProvider: "openai",
    model: "gpt-4o",
    prompt: null,
    temperature: null,
    maxTokens: null,
    toolApprovalMode: "auto",
    sharedStateEnabled: false,
    maxSteps: 10,
    apiKey: "sk-test-key",
    restUrl: null,
    tools: [],
    ...overrides,
  };
}

describe("resolveLanguageModel", () => {
  it("resolves official openai with genuine key to string model and apiKey", () => {
    const spec = createMockSpec({
      modelProvider: "openai",
      model: "gpt-4o",
      apiKey: "sk-genuine-key",
      restUrl: null,
    });
    const resolved = resolveLanguageModel(spec);
    expect(resolved).toEqual({
      model: "openai:gpt-4o",
      apiKey: "sk-genuine-key",
    });
  });

  it("omits apiKey when official openai has an anonymous placeholder key", () => {
    const spec = createMockSpec({
      modelProvider: "openai",
      model: "gpt-4o",
      apiKey: "empty",
      restUrl: null,
    });
    const resolved = resolveLanguageModel(spec);
    expect(resolved.model).toBe("openai:gpt-4o");
    expect(resolved.apiKey).toBeUndefined();
  });

  it("resolves custom restUrl for openai to LanguageModel instance (compatible mode)", () => {
    const spec = createMockSpec({
      modelProvider: "openai",
      model: "custom-vllm-model",
      apiKey: "empty",
      restUrl: "http://localhost:8000/v1",
    });
    const resolved = resolveLanguageModel(spec);
    expect(typeof resolved.model).toBe("object");
    expect(resolved.model).not.toBeNull();
    expect(resolved.apiKey).toBeUndefined();
  });

  it("handles legacy openai-compatible provider alias smoothly", () => {
    const spec = createMockSpec({
      modelProvider: "openai-compatible",
      model: "deepseek-v3",
      apiKey: "sk-custom",
      restUrl: "https://api.deepseek.com/v1",
    });
    const resolved = resolveLanguageModel(spec);
    expect(typeof resolved.model).toBe("object");
    expect(resolved.model).not.toBeNull();
    expect(resolved.apiKey).toBeUndefined();
  });

  it("resolves ollama provider with anonymous placeholder without apiKey", () => {
    const spec = createMockSpec({
      modelProvider: "ollama",
      model: "llama3",
      apiKey: "empty",
      restUrl: "http://127.0.0.1:11434",
    });
    const resolved = resolveLanguageModel(spec);
    expect(typeof resolved.model).toBe("object");
    expect(resolved.model).not.toBeNull();
    expect(resolved.apiKey).toBeUndefined();
  });

  it("resolves ollama provider with genuine apiKey", () => {
    const spec = createMockSpec({
      modelProvider: "ollama",
      model: "qwen2.5",
      apiKey: "ollama-gateway-token",
      restUrl: "https://my-ollama-gateway.example.com",
    });
    const resolved = resolveLanguageModel(spec);
    expect(typeof resolved.model).toBe("object");
    expect(resolved.model).not.toBeNull();
    expect(resolved.apiKey).toBeUndefined();
  });

  it("forwards credentialType and headerName to buildAuthHeaders for openai with custom restUrl", () => {
    const spy = vi.spyOn(bridgeRuntimeKit, "buildAuthHeaders");
    const spec = createMockSpec({
      modelProvider: "openai",
      model: "custom-model",
      apiKey: "secret-key",
      restUrl: "https://custom-gateway.com/v1",
      credentialType: "api_key",
      headerName: "X-Custom-Auth",
    });
    resolveLanguageModel(spec);
    expect(spy).toHaveBeenCalledWith("secret-key", "api_key", "X-Custom-Auth");
    spy.mockRestore();
  });

  it("forwards credentialType and headerName to buildAuthHeaders for ollama", () => {
    const spy = vi.spyOn(bridgeRuntimeKit, "buildAuthHeaders");
    const spec = createMockSpec({
      modelProvider: "ollama",
      model: "llama3",
      apiKey: "ollama-key",
      restUrl: "http://127.0.0.1:11434",
      credentialType: "api_key",
      headerName: "X-Ollama-Key",
    });
    resolveLanguageModel(spec);
    expect(spy).toHaveBeenCalledWith("ollama-key", "api_key", "X-Ollama-Key");
    spy.mockRestore();
  });
});
