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
  TranscriptionService,
} from "@/lib/copilot/index.server";

import { childLogger } from "@/lib/observability/logger";
import { scanIncomingPrompt } from "@/lib/agent-pipeline/input-safety";
import { SseStreamRedactor, type RedactionRule } from "@/lib/agent-pipeline/output-safety";
import { recordInterceptionLog } from "@/lib/agent-pipeline/guardrail-service";

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
  runId?: string;
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
  transcriptionService?: TranscriptionService;
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
    ...(input.transcriptionService ? { transcriptionService: input.transcriptionService } : {}),
  });

  const handler = createCopilotRuntimeHandler({
    runtime,
    basePath: input.endpoint,
  });

  // INBOUND PROMPT SCAN
  let scanReq = request;
  if (request.method === "POST" && /\/agent\/[^/]+\/run\b/.test(new URL(request.url).pathname)) {
    try {
      const body = await request.clone().json() as { messages?: { role?: string, content?: string }[] };
      const messages = body?.messages;
      if (Array.isArray(messages) && messages.length > 0) {
        let lastUserIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]?.role === "user") {
            lastUserIdx = i;
            break;
          }
        }
        
        if (lastUserIdx >= 0) {
          const lastMsg = messages[lastUserIdx];
          if (lastMsg && typeof lastMsg.content === "string") {
            const scanResult = await scanIncomingPrompt(lastMsg.content, input.diag?.userId, input.diag?.runId, input.diag?.agentId);
            if (scanResult.action === "block") {
              log.warn({ event: "prompt_blocked" }, "Incoming prompt blocked by guardrails");
              const messageId = `msg-blocked-${Date.now()}`;
              const errorMessage = `🚨 [Guardrails] ${scanResult.message || "Request blocked by safety policy."}`;
              
              const runId = input.diag?.runId || `run-${Date.now()}`;
              // Try to extract threadId if possible, else fallback
              const threadId = (body as Record<string, unknown>)?.threadId as string || `thread-${Date.now()}`;
              
              const sse = [
                `data: ${JSON.stringify({ type: "RUN_STARTED", threadId, runId })}\n\n`,
                `data: ${JSON.stringify({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" })}\n\n`,
                `data: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: errorMessage })}\n\n`,
                `data: ${JSON.stringify({ type: "TEXT_MESSAGE_END", messageId })}\n\n`,
                `data: ${JSON.stringify({ type: "RUN_FINISHED", threadId, runId })}\n\n`
              ].join("");

              return new Response(sse, {
                status: 200,
                headers: {
                  "Content-Type": "text/event-stream",
                  "Cache-Control": "no-cache",
                  "Connection": "keep-alive"
                }
              });
            } else if (scanResult.action === "redact" && scanResult.result) {
              messages[lastUserIdx].content = scanResult.result;
              const newHeaders = new Headers(request.headers);
              newHeaders.delete("content-length");
              scanReq = new Request(request.url, {
                method: request.method,
                headers: newHeaders,
                body: JSON.stringify(body)
              });
            }
          }
        }
      }
    } catch (e) {
      log.warn({ err: e }, "Failed to parse request for prompt scanning");
    }
  }

  const finalReq = input.trimMessages
    ? await trimHistoricalMessages(scanReq)
    : scanReq;
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
    
    // OUTBOUND SSE INTERCEPTION
    if (res.body && res.headers.get("content-type")?.includes("text/event-stream")) {
      const redactor = new SseStreamRedactor(null, (rule: RedactionRule, snippet: string) => {
        recordInterceptionLog({
          runId: input.diag?.runId ?? null,
          userId: input.diag?.userId ?? null,
          stage: "output",
          category: "output_redaction",
          policyId: 0,
          policyName: rule.name,
          policyType: "regex",
          action: "redact",
          severity: "high",
          payload: { snippet: snippet.slice(0, 100) },
        }).catch(err => log.error({err}, "Failed to record redaction log"));
      });
      const textDecoder = new TextDecoder();
      const textEncoder = new TextEncoder();
      
      const transform = new TransformStream<unknown, Uint8Array>({
        transform(chunk, controller) {
          const textChunk = typeof chunk === "string" ? chunk : textDecoder.decode(chunk as Uint8Array, { stream: true });
          const flushed = redactor.processChunk(textChunk);
          if (flushed) controller.enqueue(textEncoder.encode(flushed));
        },
        flush(controller) {
          const tail = textDecoder.decode();
          let finalFlushed = "";
          if (tail) finalFlushed += redactor.processChunk(tail);
          finalFlushed += redactor.flush();
          if (finalFlushed) controller.enqueue(textEncoder.encode(finalFlushed));
        }
      });
      
      const newBody = res.body.pipeThrough(transform);
        
      return new Response(newBody, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    }

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
