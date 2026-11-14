/**
 * Shared A2A SDK client helpers — server-only. See docs/a2a-compatibility.md.
 */

import "server-only";

import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  type Client,
} from "@a2a-js/sdk/client";
import type { AgentCard, Part, Task } from "@a2a-js/sdk";
import { TaskState } from "@a2a-js/sdk";

import { buildAuthHeaders } from "../bridge-runtime-kit.server";

/**
 * Resolve `{agentId}` template in an A2A endpoint URL.
 * When `agentId` is omitted or the URL has no `{agentId}`, returns the
 * normalized base URL as-is (single-agent fallback).
 */
export function resolveA2AEndpointUrl(templateUrl: string, agentId?: string): string {
  const cleanUrl = templateUrl.replace(/\/+$/, "");
  if (!agentId || !cleanUrl.includes("{agentId}")) {
    return cleanUrl;
  }
  return cleanUrl.replaceAll("{agentId}", encodeURIComponent(agentId));
}

/**
 * Build a `fetch` wrapper that injects credential auth headers (skipping
 * anonymous placeholders via `buildAuthHeaders`) and enforces an optional
 * per-request timeout when the caller did not supply a signal.
 */
export function createA2AFetch(
  token: string,
  type?: string,
  headerName?: string | null,
  timeoutMs?: number,
): typeof fetch {
  const authHeaders = buildAuthHeaders(token, type, headerName);
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const mergedHeaders = new Headers(authHeaders);
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        mergedHeaders.set(key, value);
      });
    }

    const signal =
      init?.signal ?? (timeoutMs && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);

    return fetch(input, {
      ...init,
      headers: mergedHeaders,
      ...(signal ? { signal } : {}),
    });
  };
}

/**
 * Fetch and normalize an A2A `AgentCard`.
 *
 * QUIRK: `DefaultAgentCardResolver.resolve(baseUrl)` uses `new URL(".well-known/agent-card.json", baseUrl)`.
 * Without a trailing slash, URL resolution strips the last path segment (e.g.
 * `http://host/a2a/agents/test_agent` -> `http://host/a2a/agents/.well-known/agent-card.json`).
 * Appending `/` preserves the full base path; `.json` URLs are fetched directly with `path=""`.
 */
export async function fetchAgentCard(
  endpointUrl: string,
  fetchImpl: typeof fetch,
): Promise<AgentCard> {
  const resolver = new DefaultAgentCardResolver({
    fetchImpl,
    legacyCompat: { enabled: true },
  });

  const clean = endpointUrl.replace(/\/+$/, "");
  if (clean.endsWith(".json")) {
    return resolver.resolve(clean, "");
  }
  return resolver.resolve(`${clean}/`);
}

/**
 * Construct an A2A `Client` from a resolved `AgentCard`, verifying that
 * selected transport URLs do not silently redirect credentials to a
 * different host than the configured endpoint (SSRF guard).
 */
export async function createA2AClientFromCard(
  card: AgentCard,
  configuredEndpointUrl: string,
  fetchImpl: typeof fetch,
): Promise<Client> {
  const expectedOrigin = new URL(configuredEndpointUrl).origin;
  const safeInterfaces = (card.supportedInterfaces ?? []).filter((iface) => {
    try {
      return new URL(iface.url).origin === expectedOrigin;
    } catch {
      return false;
    }
  });

  // SECURITY: If the card advertises interfaces on a different origin, fall back
  // to the admin-configured endpoint URL rather than sending auth headers cross-origin.
  const guardedCard: AgentCard =
    safeInterfaces.length > 0
      ? { ...card, supportedInterfaces: safeInterfaces }
      : {
          ...card,
          supportedInterfaces: [
            {
              url: configuredEndpointUrl,
              protocolBinding: "JSONRPC",
              protocolVersion: "1.0",
              tenant: "",
            },
          ],
        };

  const factory = new ClientFactory({
    transports: [
      new JsonRpcTransportFactory({ fetchImpl, legacyCompat: { enabled: true } }),
      new RestTransportFactory({ fetchImpl, legacyCompat: { enabled: true } }),
    ],
    cardResolver: new DefaultAgentCardResolver({
      fetchImpl,
      legacyCompat: { enabled: true },
    }),
  });

  return factory.createFromAgentCard(guardedCard);
}

/** Extract human-readable text from A2A v1.0 `Part[]`. */
export function extractTextFromParts(parts?: Part[]): string {
  if (!Array.isArray(parts) || parts.length === 0) return "";
  const chunks: string[] = [];
  for (const part of parts) {
    const content = part?.content;
    if (!content) continue;
    if (content.$case === "text" && typeof content.value === "string") {
      chunks.push(content.value);
    } else if (content.$case === "data" && content.value !== undefined) {
      chunks.push(`\`\`\`json\n${JSON.stringify(content.value, null, 2)}\n\`\`\``);
    } else if (content.$case === "url" && typeof content.value === "string") {
      chunks.push(content.value);
    }
  }
  return chunks.join("\n");
}

export function isTerminalTaskState(state?: TaskState): boolean {
  return (
    state === TaskState.TASK_STATE_COMPLETED ||
    state === TaskState.TASK_STATE_FAILED ||
    state === TaskState.TASK_STATE_CANCELED ||
    state === TaskState.TASK_STATE_REJECTED
  );
}

export function isInterruptedTaskState(state?: TaskState): boolean {
  return (
    state === TaskState.TASK_STATE_INPUT_REQUIRED ||
    state === TaskState.TASK_STATE_AUTH_REQUIRED
  );
}

/** Extract text from a completed `Task`'s artifacts or status message. */
export function extractTaskOutputText(task: Task): string {
  if (Array.isArray(task.artifacts) && task.artifacts.length > 0) {
    const artifactTexts = task.artifacts
      .map((a) => extractTextFromParts(a.parts))
      .filter((t) => t.trim().length > 0);
    if (artifactTexts.length > 0) {
      return artifactTexts.join("\n\n");
    }
  }
  return extractTextFromParts(task.status?.message?.parts);
}
