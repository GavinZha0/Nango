/**
 * Resolve an `AgentSpec` to the `(model, apiKey?)` pair that
 * CopilotKit's `BuiltInAgent` expects — either a native provider
 * shorthand string ("openai:gpt-4o") or an AI-SDK `LanguageModel`
 * instance for everything else.
 *
 * See docs/builtin-runtime.md.
 */

import "server-only";

import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { createOllama } from "ollama-ai-provider-v2";

import type { AgentSpec } from "./agent-spec";

export interface ResolvedModel {
  /** `"<provider>:<model>"` (CopilotKit native) or constructed
   *  `LanguageModel` instance (custom AI SDK). */
  model: string | LanguageModel;
  /** CONTRACT: only set when `model` is a string. AI-SDK instances
   *  embed their own auth — re-passing the key would be dead weight. */
  apiKey?: string;
}

/** CONTRACT: keep in sync with the switch in
 *  `node_modules/@copilotkit/runtime/dist/agent/index.mjs`. */
const NATIVE_PROVIDERS: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "google",
  "gemini",
  "google-gemini",
  "vertex",
]);

const DEFAULT_OLLAMA_HOST: string = "http://127.0.0.1:11434";

/** CONTRACT: throws on unknown providers so the route handler can
 *  surface a clear 503 instead of letting CopilotKit's default switch
 *  throw deep inside the chat stream. */
export function resolveLanguageModel(spec: AgentSpec): ResolvedModel {
  const provider: string = spec.modelProvider.toLowerCase();

  if (NATIVE_PROVIDERS.has(provider)) {
    return { model: `${provider}:${spec.model}`, apiKey: spec.apiKey };
  }

  if (provider === "ollama") {
    const baseURL: string = resolveOllamaBaseUrl(spec.restUrl);
    const ollama = createOllama({
      baseURL,
      // QUIRK: when toolChoice="none", strip `tools`/`tool_choice` from
      // every outbound body. Required for Ollama models that don't yet
      // support function calling (gemma3, mistral:7b, phi*, …); drop
      // this wrapper once they all gain native tool support.
      fetch: spec.toolChoice === "none" ? makeStripToolsFetch() : undefined,
    });
    return { model: ollama(spec.model) };
  }

  if (provider === "groq") {
    const groq = createGroq({
      apiKey: spec.apiKey,
      ...(spec.restUrl ? { baseURL: spec.restUrl } : {}),
    });
    return { model: groq(spec.model) };
  }

  if (provider === "xai") {
    const xai = createXai({
      apiKey: spec.apiKey,
      ...(spec.restUrl ? { baseURL: spec.restUrl } : {}),
    });
    return { model: xai(spec.model) };
  }

  if (provider === "deepseek") {
    const deepseek = createDeepSeek({
      apiKey: spec.apiKey,
      ...(spec.restUrl ? { baseURL: spec.restUrl } : {}),
    });
    return { model: deepseek(spec.model) };
  }

  if (provider === "openrouter") {
    // OpenRouter aggregates 200+ models behind one OpenAI-shaped API.
    // Model ids carry a vendor prefix (`anthropic/claude-3.5-sonnet`).
    const openrouter = createOpenRouter({
      apiKey: spec.apiKey,
      ...(spec.restUrl ? { baseURL: spec.restUrl } : {}),
    });
    return { model: openrouter(spec.model) };
  }

  if (provider === "openai-compatible") {
    // SECURITY: restUrl is REQUIRED — falling back to api.openai.com
    // would silently send the workload to OpenAI under whatever key
    // the credential carries.
    if (!spec.restUrl) {
      throw new Error(
        `openai-compatible provider requires a REST API URL on the credential. `
          + `Set the credential's "REST API URL" to the endpoint's chat completions base, `
          + `e.g. "https://api.together.xyz/v1" or "http://vllm-host:8000/v1".`,
      );
    }
    const compat = createOpenAICompatible({
      name: `openai-compatible:${spec.model}`,
      apiKey: spec.apiKey,
      baseURL: spec.restUrl,
    });
    return { model: compat(spec.model) };
  }

  throw new Error(
    `Unsupported model provider "${spec.modelProvider}". `
      + `Supported: ${[...NATIVE_PROVIDERS].join(", ")}, `
      + `groq, xai, deepseek, openrouter, openai-compatible, ollama.`,
  );
}

/**
 * Normalise restUrl to the form `ollama-ai-provider-v2` expects:
 * base URL including trailing `/api`, no trailing slash. Accepted
 * inputs: `http://host:11434[/]` or `http://host:11434/api[/]`.
 */
function resolveOllamaBaseUrl(restUrl: string | null): string {
  const trimmed: string = (restUrl?.trim() || DEFAULT_OLLAMA_HOST).replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

/**
 * Wrap `fetch` so every outbound Ollama request has `tools` and
 * `tool_choice` stripped. CopilotKit's `BuiltInAgent` unconditionally
 * injects two state-management tools that older Ollama models reject.
 */
function makeStripToolsFetch(): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    fetch(input, forceStripTools(init) ?? init);
}

/** Returns undefined when the body isn't a JSON string we can rewrite
 *  (e.g. ReadableStream), so caller falls back to the original init. */
function forceStripTools(init: RequestInit | undefined): RequestInit | undefined {
  if (!init || typeof init.body !== "string") return undefined;
  if (!init.body.includes('"tools"') && !init.body.includes('"tool_choice"')) {
    return undefined;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  if (!("tools" in parsed) && !("tool_choice" in parsed)) return undefined;

  delete parsed.tools;
  delete (parsed as { tool_choice?: unknown }).tool_choice;
  return { ...init, body: JSON.stringify(parsed) };
}
