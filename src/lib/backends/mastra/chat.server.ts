/**
 * Mastra chat handler — protocol bridge from Mastra's native SSE → AG-UI.
 * See docs/backend-integration.md.
 */

import "server-only";

import { AbstractAgent, EventType } from "@/lib/copilot/index.server";
import type { RunAgentInput, BaseEvent, Message } from "@/lib/copilot/index.server";
import type { Observable } from "rxjs";

import type { ChatContext, IBackendChatHandler } from "../types";
import {
  assertValidSseResponse,
  attachBridgeConfig,
  buildPassthroughAgentIfConfigured,
  createBridgeRunObservable,
  readSseLines,
  resolveBridgeCredential,
  ToolCallFilter,
} from "../bridge-runtime-kit.server";

interface MastraChunkBase {
  type: string;
  runId?: string;
  from?: string;
}

type MastraChunk = MastraChunkBase & {
  payload?: Record<string, unknown>;
};

function sanitiseMessages(messages: Message[]): Message[] {
  return messages.filter(
    (m) =>
      m.role === "user" ||
      m.role === "assistant" ||
      m.role === "system" ||
      m.role === "developer" ||
      m.role === "tool",
  );
}

interface BridgeConfig {
  /** Already trimmed of trailing slash, e.g. "http://localhost:4111/api". */
  baseUrl: string;
  apiKey: string;
  agentId: string;
}

class MastraBridgeAgent extends AbstractAgent {
  constructor(public readonly cfg: BridgeConfig) {
    super();
  }

  clone(): this {
    return attachBridgeConfig(super.clone() as this, this.cfg);
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return createBridgeRunObservable(input, async ({ abortSignal, emit, isCancelled }) => {
      // Server-injected upstream by lib/runner/inject-user-id.ts.
      const userId = input.forwardedProps?.user_id as string;

      const url = `${this.cfg.baseUrl}/agents/${encodeURIComponent(this.cfg.agentId)}/stream`;
      const response = await fetch(url, {
        method: "POST",
        signal: abortSignal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfg.apiKey}`,
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          messages: sanitiseMessages(input.messages),
          memory: {
            thread: input.threadId,
            resource: userId,
          },
          runId: input.runId,
        }),
      });

      await assertValidSseResponse(response);

      const tools = new ToolCallFilter(input.tools);

      for await (const line of readSseLines(response.body!)) {
        if (isCancelled()) break;
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let chunk: MastraChunk;
        try {
          chunk = JSON.parse(payload) as MastraChunk;
        } catch {
          continue;
        }

        const p = chunk.payload ?? {};

        switch (chunk.type) {
          case "text-start": {
            const id = (p.id as string) ?? `msg_${input.runId}`;
            emit({
              type: EventType.TEXT_MESSAGE_START,
              messageId: id,
              role: "assistant",
            });
            break;
          }
          case "text-delta": {
            const id = (p.id as string) ?? `msg_${input.runId}`;
            const text = (p.text as string) ?? "";
            if (text) {
              emit({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: id,
                delta: text,
              });
            }
            break;
          }
          case "text-end": {
            const id = (p.id as string) ?? `msg_${input.runId}`;
            emit({ type: EventType.TEXT_MESSAGE_END, messageId: id });
            break;
          }

          case "tool-call-input-streaming-start": {
            const tcId = p.toolCallId as string;
            const tcName = p.toolName as string;
            if (!tools.shouldForwardStart(tcName, tcId)) break;
            emit({
              type: EventType.TOOL_CALL_START,
              toolCallId: tcId,
              toolCallName: tcName,
            });
            break;
          }
          case "tool-call-delta": {
            const tcId = p.toolCallId as string;
            if (!tcId || !tools.isForwarded(tcId)) break;
            const delta = (p.argsTextDelta as string) ?? "";
            if (!delta) break;
            emit({
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: tcId,
              delta,
            });
            break;
          }
          case "tool-call-input-streaming-end": {
            const tcId = p.toolCallId as string;
            if (!tcId || !tools.isForwarded(tcId)) break;
            emit({ type: EventType.TOOL_CALL_END, toolCallId: tcId });
            break;
          }

          case "tool-call": {
            const tcId = p.toolCallId as string;
            const tcName = p.toolName as string;
            if (!tools.shouldForwardStart(tcName, tcId)) break;
            emit({
              type: EventType.TOOL_CALL_START,
              toolCallId: tcId,
              toolCallName: tcName,
            });
            const argsStr =
              typeof p.args === "string" ? p.args : JSON.stringify(p.args ?? {});
            emit({
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: tcId,
              delta: argsStr,
            });
            emit({ type: EventType.TOOL_CALL_END, toolCallId: tcId });
            break;
          }

          case "tool-result": {
            const tcId = p.toolCallId as string;
            if (!tcId || !tools.isForwarded(tcId)) break;
            const content =
              typeof p.result === "string" ? p.result : JSON.stringify(p.result ?? null);
            // AG-UI REQUIRES `messageId` on TOOL_CALL_RESULT — synthesise
            // a stable id from runId so persistence + replay link back
            // to the same logical turn.
            emit({
              type: EventType.TOOL_CALL_RESULT,
              messageId: `msg_${input.runId}`,
              toolCallId: tcId,
              content,
            });
            break;
          }

          case "error": {
            const err = p.error;
            const msg =
              err instanceof Error
                ? err.message
                : typeof err === "string"
                  ? err
                  : JSON.stringify(err ?? "Mastra reported an error");
            throw new Error(msg);
          }

          default:
            break;
        }
      }
    });
  }
}

export const mastraChatHandler: IBackendChatHandler = {
  provider: "mastra",

  async buildAgent(ctx: ChatContext) {
    // AG-UI fast-path when `@ag-ui/mastra`'s `registerCopilotKit` is
    // wired upstream; otherwise the chunk-protocol bridge below.
    const passthrough = await buildPassthroughAgentIfConfigured(ctx);
    if (passthrough) return passthrough;

    const credential = await resolveBridgeCredential(ctx.credentialId);
    if (!credential.ok) return credential.response;

    return new MastraBridgeAgent({
      baseUrl: credential.value.baseUrl,
      apiKey: credential.value.apiKey,
      agentId: ctx.agentId,
    });
  },
};
