/**
 * Dify chat handler — protocol bridge from Dify SSE → AG-UI.
 *
 * @see docs/backend-integration.md#11-provider-specific-quirks-and-mappings
 */

import "server-only";

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

// Dify event payloads (only the fields we read)
//
// Source of truth: dify/api/core/app/entities/task_entities.py.

interface DifyEvent {
  event?: string;
  conversation_id?: string;
  message_id?: string;
  /** message / agent_message: assistant answer delta. */
  answer?: string;
  /** Stable thought row id — same across the (thought → tool →
   *  observation) sequence, so it doubles as our toolCallId. */
  id?: string;
  position?: number;
  /** Set when this thought decided to call a tool. */
  tool?: string;
  /** JSON-encoded args (sometimes Dify emits a parsed object). */
  tool_input?: string | Record<string, unknown>;
  /** Set when this thought received the tool's output. */
  observation?: string;
  message?: string;
  code?: string;
}

// Bridging Agent

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

  /**
   * @see docs/backend-integration.md#11-provider-specific-quirks-and-mappings
   */
  clone(): this {
    return attachBridgeConfig(super.clone() as this, this.cfg);
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return createBridgeRunObservable(input, async ({ abortSignal, emit, isCancelled }) => {
      // Server-trusted: runner injects `forwardedProps.user_id` from
      // `session.user.id` (chat) or `ownerId` (programmatic dispatch)
      // before this code is reached. @see lib/runner/inject-user-id.ts
      const userId = input.forwardedProps?.user_id as string;

      const query = lastUserText(input.messages);
      if (!query) {
        throw new Error("No user message to send to Dify.");
      }

      // CONTRACT: Dify treats `conversation_id` as the upstream
      // session token. We persist it in `backend_thread_state` so a
      // Node restart between turns does NOT sever Dify-side LLM
      // memory. On the very first message of a thread there is no
      // mapping yet — we MUST omit `conversation_id` entirely
      // (Dify generates conv_ids internally and rejects unknown
      // values with 404, so passing Nango's threadId would always
      // cost a wasted round-trip). The 404/400 retry below covers
      // ONLY the stale-mapping case where we sent a known-but-
      // expired conv_id; if the initial omit-conv_id request 4xxs
      // it's a genuine error and the retry would not help.
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
        // Stale mapping: Dify-side conversation was deleted or
        // expired out-of-band. Drop the mapping and retry without
        // `conversation_id` so Dify allocates a fresh one;
        // `message_end` will repopulate the cache below.
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

      const text = new TextStreamState(emit, `msg_${input.runId}`);
      let capturedConvId: string | null = null;
      // @see docs/backend-integration.md#11-provider-specific-quirks-and-mappings
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

            // 1. Tool announcement — dify gives full args in one
            //    shot, so emit START + ARGS + END together.
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

            // 2. Observation pairs with an earlier START so
            //    CopilotKit can close the tool call.
            // SCHEMA NOTE: AG-UI requires `messageId` on TOOL_CALL_RESULT
            // (the assistant message envelope the tool call belongs to).
            // Pre-fix code omitted it under `as BaseEvent`. Synthesise
            // a stable id from runId so persistence + replay link the
            // result back to the same logical turn.
            if (thoughtId && observation && emittedToolThoughts.has(thoughtId)) {
              emit({
                type: EventType.TOOL_CALL_RESULT,
                messageId: `msg_${input.runId}`,
                toolCallId: thoughtId,
                content:
                  typeof observation === "string"
                    ? observation
                    : JSON.stringify(observation),
              });
            }

            // 3. Thought-only events carry intermediate reasoning;
            //    dropped silently because Agent mode also emits
            //    agent_message for the user-visible answer.
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
            // Anything not yet bridged (workflow_*, node_*,
            // iteration_*, loop_*, tts_*, message_file, …) gets
            // debug-logged so support can spot growth without
            // spamming production.
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
        // Fire-and-forget: cache update is synchronous inside the
        // DAO so this process reuses the value immediately; the DB
        // write must not block the bridge stream's completion. A
        // failed persist is logged inside the DAO.
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

// Public chat handler

export const difyChatHandler: IBackendChatHandler = {
  provider: "dify",

  async buildAgent(ctx: ChatContext) {
    // Dify itself doesn't speak AG-UI today, but a deployer could
    // front it with an AG-UI shim and configure `aguiUrl`. No-op
    // otherwise.
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
