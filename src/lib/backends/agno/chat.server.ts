/**
 * agno chat handler — protocol bridge from agno AgentOS SSE → AG-UI.
 *
 * @see docs/backend-integration.md#11-provider-specific-quirks-and-mappings
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
  ToolCallFilter,
} from "../bridge-runtime-kit.server";

type Logger = ReturnType<typeof childLogger>;

// agno event payload shape (only the fields we consume)

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
  /** Text delta for RunContent/TeamRunContent; error message for RunError. */
  content?: unknown;
  /** Streaming reasoning delta (`ReasoningContentDelta`) or full step text. */
  reasoning_content?: string | null;
  /** ToolCallStarted payload. */
  tool?: AgnoToolExecution | null;
  [k: string]: unknown;
}

// Helpers

function endpointFor(kind: EntityKind, id: string): string {
  // Workflows have no chat-thread concept; route to /agents to keep
  // the path well-formed (caller already vets `kind` server-side).
  const segment = kind === "team" ? "teams" : "agents";
  return `/${segment}/${encodeURIComponent(id)}/runs`;
}

interface SseMessage {
  /** Value of the most recent `event:` line, or `""` if absent. */
  event: string;
  /** Joined value of all `data:` lines, with single LF separators. */
  data: string;
}

/**
 * CONTRACT: standards-compliant SSE message stream per WHATWG HTML
 * "Interpreting an event stream" — CR/LF/CRLF separators, blank-line
 * dispatch, `field:value` with optional leading-space trim, multi-line
 * `data:` joined by LF, leading `:` is a comment, empty events skipped.
 * `id` and `retry` are ignored (we don't reconnect).
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

// Bridging Agent

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

  // @see docs/backend-integration.md#11-provider-specific-quirks-and-mappings
  clone(): this {
    return attachBridgeConfig(super.clone() as this, this.cfg);
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return createBridgeRunObservable(
      input,
      async ({ abortSignal, emit, isCancelled }) => {
        // Server-trusted: runner injects `forwardedProps.user_id` from
        // `session.user.id` (chat) or `ownerId` (programmatic dispatch)
        // before this code is reached. @see lib/runner/inject-user-id.ts
        const userId = input.forwardedProps?.user_id as string;
        const message = lastUserText(input.messages);
        if (!message) {
          throw new Error("No user message to send to agno.");
        }

        const tools = new ToolCallFilter(input.tools);
        const text = new TextStreamState(emit, randomUUID());

        // Reasoning state — agno-specific, no shared helper yet.
        // SCHEMA NOTE: AG-UI requires `messageId` on REASONING_START /
        // REASONING_END (the outer span) AND on the inner MESSAGE_*
        // events. Pre-fix code passed neither and got away with it
        // because `as BaseEvent` erased the schema's required-field
        // checks. Single span id reused for both pairs since they
        // identify the same logical reasoning turn; the persistence
        // layer (PersistingAgent) only reads messageId on the inner
        // MESSAGE_* events anyway. REASONING_MESSAGE_START's required
        // `role: "reasoning"` literal was also previously missing.
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

        // @see docs/backend-integration.md#11-provider-specific-quirks-and-mappings
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
          // `event` key is a fallback (never missing in agno 2.6.4).
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
              // @see docs/backend-integration.md#11-provider-specific-quirks-and-mappings
              if (reasoningRunOpen) closeReasoning();
              text.appendDelta(delta);
              break;
            }

            case "ReasoningStarted":
            case "TeamReasoningStarted":
              openReasoning();
              break;
            // @see docs/backend-integration.md#11-provider-specific-quirks-and-mappings
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
              if (!tools.shouldForwardStart(tcName, tcId)) break;
              // Close any open assistant text / reasoning so the tool
              // call doesn't get nested under them.
              text.closeIfOpen();
              if (reasoningRunOpen) closeReasoning();
              emit({
                type: EventType.TOOL_CALL_START,
                toolCallId: tcId,
                toolCallName: tcName,
              });
              // CONTRACT: `tool_args` is always Dict[str, Any] in agno;
              // JSON-stringify for the AG-UI delta.
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

            // Everything else (RunStarted/Completed/Cancelled, hooks,
            // memory updates, session summaries, model metrics, …) is
            // silently dropped — the browser has no rendering for it.
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

        // Stream ended cleanly — close any open streams.
        // createBridgeRunObservable emits RUN_FINISHED on return.
        text.closeIfOpen();
        closeReasoning();
      },
    );
  }
}

// Handler

export const agnoChatHandler: IBackendChatHandler = {
  provider: "agno",

  async buildAgent(ctx: ChatContext) {
    // AG-UI fast-path when the deployer mounted `AGUI(agent=…)` and
    // the credential's aguiUrl is set; falls back to bridge below.
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
