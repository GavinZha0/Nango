/**
 * agno chat handler — protocol bridge from agno AgentOS SSE → AG-UI.
 * See docs/backend-integration.md.
 */

import "server-only";

import { AbstractAgent, EventType } from "@/lib/copilot/index.server";
import type { RunAgentInput, BaseEvent } from "@/lib/copilot/index.server";
import type { Observable } from "rxjs";
import { randomUUID } from "node:crypto";

import { childLogger } from "@/lib/observability/logger";
import type { ChatContext, EntityKind, IBackendChatHandler } from "../types";
import {
  attachBridgeConfig,
  buildPassthroughAgentIfConfigured,
  createBridgeRunObservable,
  lastUserText,
  readShortErrorBody,
  resolveBridgeCredential,
  TextStreamState,
} from "../bridge-runtime-kit.server";

type Logger = ReturnType<typeof childLogger>;

/** Subset of `agno.models.response.ToolExecution` that we read. */
interface AgnoToolExecution {
  tool_call_id?: string;
  tool_name?: string;
  tool_args?: Record<string, unknown> | null;
  result?: string | null;
}

interface AgnoEvent {
  /** PascalCase discriminator, e.g. "RunContent", "TeamReasoningStep". */
  event: string;
  content?: unknown;
  reasoning_content?: string | null;
  tool?: AgnoToolExecution | null;
  [k: string]: unknown;
}

function endpointFor(kind: EntityKind, id: string): string {
  // Workflows have no chat-thread concept — route to /agents.
  const segment = kind === "team" ? "teams" : "agents";
  return `/${segment}/${encodeURIComponent(id)}/runs`;
}

interface SseMessage {
  event: string;
  data: string;
}

/**
 * CONTRACT: WHATWG-compliant SSE parser. CR/LF/CRLF separators,
 * blank-line dispatch, optional leading-space trim on values,
 * multi-line `data:` joined by LF, `:` is comment. `id` / `retry`
 * ignored — we never reconnect.
 */
async function* readSseMessages(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];

  const dispatch = (): SseMessage | null => {
    const data = dataLines.join("\n");
    const ev = eventName;
    eventName = "";
    dataLines = [];
    if (data.length === 0) return null;
    return { event: ev, data };
  };

  const handleLine = (line: string): SseMessage | null => {
    if (line.length === 0) return dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    return null;
  };

  const lineRegex = /\r\n|\n|\r/;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let match: RegExpExecArray | null;
    while ((match = lineRegex.exec(buffer))) {
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const msg = handleLine(line);
      if (msg) yield msg;
    }
  }
  if (buffer.length > 0) {
    const msg = handleLine(buffer);
    if (msg) yield msg;
  }
  const tail = dispatch();
  if (tail) yield tail;
}

interface BridgeConfig {
  baseUrl: string;
  apiKey: string;
  entityId: string;
  entityKind: EntityKind;
  log: Logger;
}

class AgnoBridgeAgent extends AbstractAgent {
  constructor(public readonly cfg: BridgeConfig) {
    super();
  }

  clone(): this {
    return attachBridgeConfig(super.clone() as this, this.cfg);
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return createBridgeRunObservable(
      input,
      async ({ abortSignal, emit, isCancelled }) => {
        // Server-injected upstream by lib/runner/inject-user-id.ts.
        const userId = input.forwardedProps?.user_id as string;
        const message = lastUserText(input.messages);
        if (!message) {
          throw new Error("No user message to send to agno.");
        }

        // agno agents own their tools server-side; the names are NOT
        // in CopilotKit's `input.tools` (those are frontend-registered
        // tools like handoff / HITL). A simple set deduplicates
        // double-emissions without filtering out backend-owned calls.
        const emittedToolCalls = new Set<string>();
        let textMsgId: string = randomUUID();
        let text = new TextStreamState(emit, textMsgId);

        // Reasoning span — agno-specific, no shared helper yet.
        // AG-UI REQUIRES messageId on REASONING_START / END (outer span)
        // and on the inner MESSAGE_* events. Single span id reused
        // across both pairs (same logical reasoning turn).
        let reasoningSpanId: string | null = null;
        let reasoningRunOpen = false;
        let reasoningMessageOpen = false;
        const openReasoning = (): void => {
          if (!reasoningSpanId) reasoningSpanId = randomUUID();
          if (!reasoningRunOpen) {
            emit({
              type: EventType.REASONING_START,
              messageId: reasoningSpanId,
            });
            reasoningRunOpen = true;
          }
          if (!reasoningMessageOpen) {
            emit({
              type: EventType.REASONING_MESSAGE_START,
              messageId: reasoningSpanId,
              role: "reasoning",
            });
            reasoningMessageOpen = true;
          }
        };
        const closeReasoning = (): void => {
          if (reasoningMessageOpen && reasoningSpanId) {
            emit({
              type: EventType.REASONING_MESSAGE_END,
              messageId: reasoningSpanId,
            });
            reasoningMessageOpen = false;
          }
          if (reasoningRunOpen && reasoningSpanId) {
            emit({
              type: EventType.REASONING_END,
              messageId: reasoningSpanId,
            });
            reasoningRunOpen = false;
          }
          reasoningSpanId = null;
        };

        const form = new FormData();
        form.set("message", message);
        form.set("stream", "true");
        form.set("monitor", "true");
        form.set("session_id", input.threadId);
        form.set("user_id", userId);

        const url = `${this.cfg.baseUrl}${endpointFor(
          this.cfg.entityKind,
          this.cfg.entityId,
        )}`;
        this.cfg.log.info(
          {
            event: "agno_upstream_request",
            url,
            entityKind: this.cfg.entityKind,
            entityId: this.cfg.entityId,
            messageLen: message.length,
            sessionId: input.threadId,
          },
          "agno upstream request",
        );
        const res = await fetch(url, {
          method: "POST",
          signal: abortSignal,
          headers: {
            Authorization: `Bearer ${this.cfg.apiKey}`,
            Accept: "text/event-stream",
          },
          body: form,
        });

        this.cfg.log.info(
          {
            event: "agno_upstream_response",
            status: res.status,
            contentType: res.headers.get("content-type"),
            hasBody: !!res.body,
          },
          "agno upstream response received",
        );

        if (!res.ok || !res.body) {
          const text = await readShortErrorBody(res);
          throw new Error(
            `Upstream ${res.status} ${res.statusText}: ${text}`,
          );
        }

        let messageCount = 0;
        let droppedEventCount = 0;
        for await (const sse of readSseMessages(res.body)) {
          if (isCancelled()) break;
          let chunk: AgnoEvent;
          try {
            chunk = JSON.parse(sse.data) as AgnoEvent;
          } catch (err) {
            this.cfg.log.warn(
              {
                event: "agno_parse_error",
                sseEvent: sse.event,
                dataPreview: sse.data.slice(0, 200),
                err: err instanceof Error ? err.message : String(err),
              },
              "agno upstream emitted invalid JSON",
            );
            continue;
          }
          // CONTRACT: SSE `event:` header is authoritative; body's
          // `event` key is a fallback.
          const agnoEvent = sse.event || chunk.event;
          messageCount += 1;
          this.cfg.log.debug(
            { event: "agno_upstream_event", index: messageCount, agnoEvent },
            "agno upstream event",
          );

          switch (agnoEvent) {
            case "RunContent":
            case "TeamRunContent": {
              const delta =
                typeof chunk.content === "string" ? chunk.content : "";
              if (!delta) break;
              if (reasoningRunOpen) closeReasoning();
              text.appendDelta(delta);
              break;
            }

            case "ReasoningStarted":
            case "TeamReasoningStarted":
              openReasoning();
              break;
            case "ReasoningContentDelta":
            case "TeamReasoningContentDelta":
            case "ReasoningStep":
            case "TeamReasoningStep": {
              const delta = chunk.reasoning_content ?? "";
              if (!delta) break;
              openReasoning();
              emit({
                type: EventType.REASONING_MESSAGE_CONTENT,
                messageId: reasoningSpanId!,
                delta,
              });
              break;
            }
            case "ReasoningCompleted":
            case "TeamReasoningCompleted":
              closeReasoning();
              break;

            case "ToolCallStarted":
            case "TeamToolCallStarted": {
              const tool = chunk.tool ?? {};
              const tcId = tool.tool_call_id ?? "";
              const tcName = tool.tool_name ?? "";
              if (!tcId || !tcName || emittedToolCalls.has(tcId)) break;
              emittedToolCalls.add(tcId);
              // Close open text / reasoning so the tool call isn't nested.
              text.closeIfOpen();
              if (reasoningRunOpen) closeReasoning();
              emit({
                type: EventType.TOOL_CALL_START,
                toolCallId: tcId,
                toolCallName: tcName,
              });
              emit({
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: tcId,
                delta: JSON.stringify(tool.tool_args ?? {}),
              });
              emit({
                type: EventType.TOOL_CALL_END,
                toolCallId: tcId,
              });
              break;
            }

            case "ToolCallCompleted":
            case "TeamToolCallCompleted": {
              const tool = chunk.tool ?? {};
              const tcId = tool.tool_call_id ?? "";
              if (!tcId || !emittedToolCalls.has(tcId)) break;
              const result = tool.result ?? "";
              emit({
                type: EventType.TOOL_CALL_RESULT,
                messageId: textMsgId,
                toolCallId: tcId,
                content:
                  typeof result === "string"
                    ? result
                    : JSON.stringify(result),
              });
              // Mint a fresh messageId so post-tool text gets its own
              // message bubble (same pattern as Dify / Mastra bridges).
              textMsgId = randomUUID();
              text = new TextStreamState(emit, textMsgId);
              break;
            }

            case "RunError":
            case "TeamRunError": {
              const message =
                typeof chunk.content === "string" && chunk.content
                  ? chunk.content
                  : "agno run error";
              this.cfg.log.warn(
                { event: "agno_run_error", message },
                "agno upstream emitted run error",
              );
              text.closeIfOpen();
              closeReasoning();
              throw new Error(message);
            }

            // RunStarted/Completed/Cancelled, hooks, memory updates,
            // session summaries, model metrics, … — silently dropped.
            default:
              droppedEventCount += 1;
              break;
          }
        }
        this.cfg.log.info(
          {
            event: "agno_stream_drained",
            messageCount,
            droppedEventCount,
            emittedText: text.isOpen,
          },
          "agno upstream stream drained",
        );

        text.closeIfOpen();
        closeReasoning();
      },
    );
  }
}

export const agnoChatHandler: IBackendChatHandler = {
  provider: "agno",

  async buildAgent(ctx: ChatContext) {
    // AG-UI fast-path when the credential's aguiUrl is set; else bridge.
    const passthrough = await buildPassthroughAgentIfConfigured(ctx);
    if (passthrough) return passthrough;

    const credential = await resolveBridgeCredential(ctx.credentialId, {
      errorMessages: {
        missingRestUrl: "agno credential is missing restUrl.",
        missingToken: "agno credential is missing an auth token.",
      },
    });
    if (!credential.ok) return credential.response;

    const log = childLogger({
      component: "agno-bridge",
      agentId: ctx.agentId,
      agentKind: ctx.agentKind,
      credentialId: ctx.credentialId,
      userId: ctx.userId,
    });
    return new AgnoBridgeAgent({
      baseUrl: credential.value.baseUrl,
      apiKey: credential.value.apiKey,
      entityId: ctx.agentId,
      entityKind: ctx.agentKind,
      log,
    });
  },
};
