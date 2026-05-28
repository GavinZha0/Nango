/**
 * AG-UI runtime entry point used by chat dispatch — shared between
 * backend and built-in routes. See `docs/orchestrator.md` for the
 * convergence-point rationale.
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

/** Discriminates dispatch lineage in logs and (in the future) traces. */
export type EntitySource = "backend" | "builtin";

/**
 * Trim CopilotKit v2 payload to latest user message + everything after.
 * Only meaningful for backend agents (external backends own their own
 * conversation memory). Built-in LLM agents need the full history.
 *
 * @see docs/backend-integration.md#12-ag-ui-runtime-quirks
 */
async function trimHistoricalMessages(request: Request): Promise<Request> {
  if (request.method !== "POST") return request;
  if (!/\/agent\/[^/]+\/run\b/.test(new URL(request.url).pathname)) {
    return request;
  }

  // Read once (body is consumed), mutate, repackage.
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

/**
 * Diagnostic fields surfaced on the dispatch log entry. Optional —
 * each caller knows its own context shape.
 */
export interface RunWithAgentsDiag {
  agentId?: string;
  credentialId?: string;
  userId?: string;
}

/**
 * CONTRACT: every chat dispatch (backend + built-in) flows through
 * here. Callers prepare `agents` + `runner` + `endpoint` upstream and
 * this function owns the CopilotKit runtime construction.
 */
export interface RunWithAgentsInput {
  /** Agent id → agent map handed to CopilotRuntime. Backend dispatch
   *  is always a single entry; built-in dispatch may have multiple
   *  (only one is hit per request by the URL agentId). */
  agents: Record<string, AbstractAgent>;
  /** CopilotKit basePath, e.g. "/api/copilotkit" (backend) or
   *  "/api/copilotkit/builtin" (built-in). */
  endpoint: string;
  /** Optional DB-backed runner. Unset only for bookkeeping fast paths
   *  (/info, /threads/*). */
  runner?: AgentRunner;
  /** External-backend dispatches set this to `true` so the
   *  `messages[]` payload is trimmed to "last user msg + after"
   *  before being handed to the upstream platform (whose own session
   *  memory continues the history). Built-in dispatches must pass
   *  `false` — built-in LLM agents need the full history. */
  trimMessages: boolean;
  /** Lineage discriminator for log entries. */
  entitySource: EntitySource;
  /** Optional diagnostic fields surfaced on the dispatch log entry. */
  diag?: RunWithAgentsDiag;
}

/**
 * Single entry point for plugging an `AbstractAgent` map into
 * `CopilotRuntime`. This is the "execution convergence point" for
 * backend and built-in chat dispatches — from here on, every line of
 * code runs the same way regardless of lineage.
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
    // Optional DB-backed AgentRunner override. When the runner.ts
    // caller constructs a `PersistedAgentRunner` for the request, we
    // plug it in here so persistence + history-replay applies to
    // every dispatch path through the same hook. Bookkeeping fast
    // paths (/info, /threads/...) leave `runner` unset and fall back
    // to CopilotKit's default in-memory runner.
    // @see docs/persisted-agent-runner-migration.md
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
