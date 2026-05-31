/**
 * AG-UI runtime entry point used by chat dispatch — shared between
 * backend and built-in routes. See docs/orchestrator.md.
 */

import "server-only";

import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
} from "@/lib/copilot/index.server";
import type {
  AbstractAgent,
  AgentRunner,
} from "@/lib/copilot/index.server";

import { childLogger } from "@/lib/observability/logger";

/** Discriminates dispatch lineage in logs. */
export type EntitySource = "backend" | "builtin";

/**
 * Trim CopilotKit v2 payload to latest user message + everything after.
 * Only meaningful for backend agents (external backends own their own
 * conversation memory). Built-in LLM agents need the full history.
 * See docs/backend-integration.md.
 */
async function trimHistoricalMessages(request: Request): Promise<Request> {
  if (request.method !== "POST") return request;
  if (!/\/agent\/[^/]+\/run\b/.test(new URL(request.url).pathname)) {
    return request;
  }

  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return request;
  }
  if (!body || typeof body !== "object") return request;

  const obj = body as { messages?: { role?: string }[] };
  const messages = obj.messages;
  if (!Array.isArray(messages) || messages.length === 0) return request;

  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx <= 0) return request;

  const trimmed = { ...obj, messages: messages.slice(lastUserIdx) };
  const headers = new Headers(request.headers);
  headers.delete("content-length"); // recompute downstream
  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify(trimmed),
  });
}

export interface RunWithAgentsDiag {
  agentId?: string;
  credentialId?: string;
  userId?: string;
}

/** CONTRACT: every chat dispatch (backend + built-in) flows through here. */
export interface RunWithAgentsInput {
  agents: Record<string, AbstractAgent>;
  /** CopilotKit basePath, e.g. "/api/copilotkit". */
  endpoint: string;
  /** Optional DB-backed runner. Unset for /info and /threads/* fast paths. */
  runner?: AgentRunner;
  /** Backend dispatch: trim `messages[]` to "last user msg + after"
   *  (external backends own conversation memory). Built-in must pass false. */
  trimMessages: boolean;
  entitySource: EntitySource;
  diag?: RunWithAgentsDiag;
}

/**
 * Single entry point for plugging an `AbstractAgent` map into
 * `CopilotRuntime` — the execution convergence point for backend and
 * built-in chat dispatches.
 */
export async function runWithAgents(
  request: Request,
  input: RunWithAgentsInput,
): Promise<Response> {
  const log = childLogger({
    component: "runtime-dispatch",
    entitySource: input.entitySource,
    agentId: input.diag?.agentId,
    credentialId: input.diag?.credentialId,
    userId: input.diag?.userId,
    method: request.method,
    path: new URL(request.url).pathname,
  });

  const runtime = new CopilotRuntime({
    agents: input.agents,
    ...(input.runner ? { runner: input.runner } : {}),
  });

  const handler = createCopilotRuntimeHandler({
    runtime,
    basePath: input.endpoint,
  });

  const finalReq = input.trimMessages
    ? await trimHistoricalMessages(request)
    : request;
  const start = Date.now();
  try {
    const res = await handler(finalReq);
    log.info(
      {
        event: "runtime_dispatch",
        status: res.status,
        durationMs: Date.now() - start,
      },
      "runtime dispatch ok",
    );
    return res;
  } catch (err) {
    log.error(
      {
        event: "runtime_dispatch",
        durationMs: Date.now() - start,
        err:
          err instanceof Error
            ? { message: err.message, name: err.name }
            : String(err),
      },
      "runtime dispatch failed",
    );
    throw err;
  }
}
