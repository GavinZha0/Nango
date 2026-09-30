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
import {
  buildAuthHeaders,
  isAnonymousPlaceholder,
} from "@/lib/backends/bridge-runtime-kit.server";

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

  if (provider === "openai" || provider === "openai-compatible") {
    // If a custom restUrl is provided,
    // construct an OpenAI-compatible instance bound to that specific baseURL and dynamic headers.
    if (spec.restUrl) {
      const compat = createOpenAICompatible({
        name: `openai:${spec.model}`,
        baseURL: spec.restUrl.replace(/\/+$/, ""),
        headers: buildAuthHeaders(spec.apiKey, spec.credentialType, spec.headerName),
      });
      return { model: compat(spec.model) };
    }

    // Default official OpenAI endpoint (no custom restUrl configured).
    // Safely omit apiKey if it's an anonymous placeholder.
    const apiKey = isAnonymousPlaceholder(spec.apiKey) ? undefined : spec.apiKey;
    return {
      model: `openai:${spec.model}`,
      ...(apiKey ? { apiKey } : {}),
    };
  }

  if (NATIVE_PROVIDERS.has(provider)) {
    return { model: `${provider}:${spec.model}`, apiKey: spec.apiKey };
  }

  if (provider === "ollama") {
    const baseURL: string = resolveOllamaBaseUrl(spec.restUrl);
    const headers = buildAuthHeaders(spec.apiKey, spec.credentialType, spec.headerName);
    const ollama = createOllama({
      baseURL,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
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

  throw new Error(
    `Unsupported model provider "${spec.modelProvider}". `
      + `Supported: openai, ${[...NATIVE_PROVIDERS].join(", ")}, `
      + `groq, xai, deepseek, openrouter, ollama.`,
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
