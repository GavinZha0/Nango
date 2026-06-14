/**
 * Dify chat handler — protocol bridge from Dify SSE → AG-UI.
 * See docs/backend-integration.md.
 */

import "server-only";

import { randomUUID } from "node:crypto";

import { AbstractAgent, EventType } from "@/lib/copilot/index.server";
import type { RunAgentInput, BaseEvent } from "@/lib/copilot/index.server";
import type { Observable } from "rxjs";

import { childLogger } from "@/lib/observability/logger";
import type { ChatContext, IBackendChatHandler } from "../types";
import {
  assertValidSseResponse,
  attachBridgeConfig,
  buildPassthroughAgentIfConfigured,
  createBridgeRunObservable,
  lastUserText,
  readSseLines,
  resolveBridgeCredential,
  TextStreamState,
} from "../bridge-runtime-kit.server";
import {
  getThreadProviderState,
  setThreadProviderState,
} from "../thread-state.server";

const log = childLogger({ component: "dify-bridge" });

/** Persisted shape under `state.dify` in `backend_thread_state`. */
interface DifyThreadState {
  convId: string;
}

interface DifyChatBody {
  inputs: Record<string, unknown>;
  query: string;
  response_mode: "streaming";
  user: string;
  conversation_id?: string;
}

async function postChat(
  baseUrl: string,
  apiKey: string,
  body: DifyChatBody,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(`${baseUrl}/chat-messages`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });
}

/** Dify event payload subset. Source of truth: dify/api/core/app/entities/task_entities.py. */
interface DifyEvent {
  event?: string;
  conversation_id?: string;
  message_id?: string;
  /** message / agent_message: assistant answer delta. */
  answer?: string;
  /** Stable thought row id — same across (thought → tool → observation),
   *  so it doubles as our toolCallId. */
  id?: string;
  position?: number;
  tool?: string;
  /** JSON-encoded args; sometimes Dify emits a parsed object. */
  tool_input?: string | Record<string, unknown>;
  observation?: string;
  message?: string;
  code?: string;
}

interface BridgeConfig {
  /** Trimmed, e.g. "https://api.dify.ai/v1". */
  baseUrl: string;
  apiKey: string;
  credentialId: string;
}

/** @internal Exported for unit tests; consumers go through {@link difyChatHandler}. */
export class DifyBridgeAgent extends AbstractAgent {
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

      const query = lastUserText(input.messages);
      if (!query) {
        throw new Error("No user message to send to Dify.");
      }

      // CONTRACT: Dify owns `conversation_id` — it generates the id
      // internally and rejects unknown values with 404. On the first
      // turn we MUST omit it; on later turns we send the persisted
      // mapping. The 404/400 retry below covers stale mappings only;
      // a first-turn 4xx is a genuine error and retry would not help.
      const persisted = await getThreadProviderState<DifyThreadState>(
        this.cfg.credentialId,
        input.threadId,
        "dify",
      );
      const mapped = persisted?.convId;

      let response = await postChat(
        this.cfg.baseUrl,
        this.cfg.apiKey,
        {
          inputs: {},
          query,
          response_mode: "streaming",
          user: userId,
          ...(mapped ? { conversation_id: mapped } : {}),
        },
        abortSignal,
      );

      if (mapped && (response.status === 404 || response.status === 400)) {
        // Stale mapping — retry without conversation_id so Dify
        // allocates a fresh one; message_end repopulates the cache.
        response = await postChat(
          this.cfg.baseUrl,
          this.cfg.apiKey,
          {
            inputs: {},
            query,
            response_mode: "streaming",
            user: userId,
          },
          abortSignal,
        );
      }

      await assertValidSseResponse(response);

      // Each distinct text segment (before / after tool calls) gets its
      // own messageId so CopilotKit doesn't merge them into one bubble.
      // After a TOOL_CALL_RESULT the text state is recreated with a
      // fresh id; the result's messageId stays tied to the preceding
      // assistant message that initiated the call.
      let textMsgId: string = randomUUID();
      let text = new TextStreamState(emit, textMsgId);
      let capturedConvId: string | null = null;
      const emittedToolThoughts = new Set<string>();

      for await (const line of readSseLines(response.body!)) {
        if (isCancelled()) break;
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let evt: DifyEvent;
        try {
          evt = JSON.parse(payload) as DifyEvent;
        } catch {
          continue;
        }

        switch (evt.event) {
          case "message":
          case "agent_message": {
            text.appendDelta(evt.answer ?? "");
            break;
          }

          case "agent_thought": {
            const thoughtId = evt.id ?? "";
            const toolName = evt.tool ?? "";
            const observation = evt.observation ?? "";

            // Dify gives full args in one shot — emit START + ARGS + END together.
            if (thoughtId && toolName && !emittedToolThoughts.has(thoughtId)) {
              emittedToolThoughts.add(thoughtId);
              text.closeIfOpen();
              emit({
                type: EventType.TOOL_CALL_START,
                toolCallId: thoughtId,
                toolCallName: toolName,
              });
              const argsStr =
                typeof evt.tool_input === "string"
                  ? evt.tool_input
                  : JSON.stringify(evt.tool_input ?? {});
              emit({
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: thoughtId,
                delta: argsStr,
              });
              emit({
                type: EventType.TOOL_CALL_END,
                toolCallId: thoughtId,
              });
            }

            // Observation pairs with the earlier START so CopilotKit
            // can close the tool call. AG-UI REQUIRES `messageId` on
            // TOOL_CALL_RESULT — use the current text segment's id
            // (which belongs to the assistant message that invoked
            // the tool). After emitting the result, mint a fresh id
            // for subsequent text so the reply doesn't merge into the
            // tool-call bubble.
            if (thoughtId && observation && emittedToolThoughts.has(thoughtId)) {
              emit({
                type: EventType.TOOL_CALL_RESULT,
                messageId: textMsgId,
                toolCallId: thoughtId,
                content:
                  typeof observation === "string"
                    ? observation
                    : JSON.stringify(observation),
              });
              textMsgId = randomUUID();
              text = new TextStreamState(emit, textMsgId);
            }

            // Thought-only events carry intermediate reasoning; dropped
            // silently because Agent mode also emits agent_message for
            // the user-visible answer.
            break;
          }

          case "message_end": {
            text.closeIfOpen();
            if (evt.conversation_id) {
              capturedConvId = evt.conversation_id;
            }
            break;
          }

          case "error": {
            throw new Error(evt.message ?? "Dify reported an unknown error.");
          }

          case "ping":
            break;

          default:
            // workflow_*, node_*, iteration_*, loop_*, tts_*,
            // message_file, … — debug-logged so support can spot
            // growth without spamming production.
            log.debug(
              { event: "dify_unbridged_event", difyEvent: evt.event },
              "dify event not bridged",
            );
            break;
        }
      }

      // Drained without explicit message_end (rare but possible).
      text.closeIfOpen();

      if (capturedConvId) {
        // Fire-and-forget — DB write MUST NOT block stream completion.
        void setThreadProviderState(
          this.cfg.credentialId,
          input.threadId,
          "dify",
          { convId: capturedConvId } satisfies DifyThreadState,
        );
      }
    });
  }
}

export const difyChatHandler: IBackendChatHandler = {
  provider: "dify",

  async buildAgent(ctx: ChatContext) {
    // AG-UI fast-path when an upstream shim configures `aguiUrl`.
    const passthrough = await buildPassthroughAgentIfConfigured(ctx);
    if (passthrough) return passthrough;

    const credential = await resolveBridgeCredential(ctx.credentialId);
    if (!credential.ok) return credential.response;

    return new DifyBridgeAgent({
      baseUrl: credential.value.baseUrl,
      apiKey: credential.value.apiKey,
      credentialId: ctx.credentialId,
    });
  },
};
