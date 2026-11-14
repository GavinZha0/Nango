/**
 * A2A chat handler — protocol bridge from A2A v1.0 (Streaming & Polling) → AG-UI.
 * See docs/a2a-compatibility.md.
 */

import "server-only";

import { randomUUID } from "node:crypto";
import {
  Role,
  TaskState,
  type AgentCard,
  type Message as A2AMessage,
  type Task,
} from "@a2a-js/sdk";
import type { Client } from "@a2a-js/sdk/client";
import type { Observable } from "rxjs";

import { AbstractAgent, EventType } from "@/lib/copilot/index.server";
import type { AgUiEvent, BaseEvent, RunAgentInput } from "@/lib/copilot/index.server";
import { childLogger } from "@/lib/observability/logger";
import type { ChatContext, IBackendChatHandler } from "../types";
import {
  attachBridgeConfig,
  createBridgeRunObservable,
  lastUserText,
  resolveBridgeCredential,
  TextStreamState,
} from "../bridge-runtime-kit.server";
import {
  createA2AClientFromCard,
  createA2AFetch,
  extractTaskOutputText,
  extractTextFromParts,
  fetchAgentCard,
  isInterruptedTaskState,
  isTerminalTaskState,
  resolveA2AEndpointUrl,
} from "./client.server";

type Logger = ReturnType<typeof childLogger>;

const POLL_INITIAL_MS = 1000;
const POLL_MAX_MS = 8000;

interface A2AConfig {
  credentialId: string;
  agentId: string;
  endpointUrl: string;
  token: string;
  type?: string;
  headerName?: string | null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function formatTaskFailure(task: { status?: { state?: TaskState; message?: A2AMessage } }): string {
  const state = task.status?.state;
  const detail = extractTextFromParts(task.status?.message?.parts);
  if (state === TaskState.TASK_STATE_INPUT_REQUIRED) {
    return detail
      ? `External A2A agent requested additional input: ${detail}`
      : "External A2A agent requested additional input.";
  }
  if (state === TaskState.TASK_STATE_AUTH_REQUIRED) {
    return detail
      ? `External A2A agent requires authentication: ${detail}`
      : "External A2A agent requires authentication.";
  }
  if (state === TaskState.TASK_STATE_REJECTED) {
    return detail ? `Task rejected by A2A agent: ${detail}` : "Task rejected by A2A agent.";
  }
  if (state === TaskState.TASK_STATE_CANCELED) {
    return detail ? `Task canceled: ${detail}` : "Task canceled by A2A agent.";
  }
  return detail ? `A2A task failed: ${detail}` : "A2A task failed.";
}

function isTaskPayload(value: A2AMessage | Task): value is Task {
  return "status" in value && !("parts" in value);
}

/**
 * Poll `getTask` with exponential backoff until a terminal or interrupted state.
 */
async function pollTaskUntilTerminal(
  client: Client,
  taskId: string,
  abortSignal: AbortSignal,
  textState: TextStreamState,
  hasEmittedOutput: () => boolean,
): Promise<Task> {
  let delayMs = POLL_INITIAL_MS;

  while (!abortSignal.aborted) {
    const task = await client.getTask(
      { id: taskId, tenant: "" },
      { signal: abortSignal },
    );
    const state = task.status?.state;

    if (isInterruptedTaskState(state)) {
      throw new Error(formatTaskFailure(task));
    }

    if (isTerminalTaskState(state)) {
      if (state !== TaskState.TASK_STATE_COMPLETED) {
        throw new Error(formatTaskFailure(task));
      }
      if (!hasEmittedOutput()) {
        const finalText = extractTaskOutputText(task);
        if (finalText) {
          textState.appendDelta(finalText);
        }
      }
      return task;
    }

    await sleep(delayMs, abortSignal);
    delayMs = Math.min(delayMs * 2, POLL_MAX_MS);
  }

  throw new Error("A2A task polling aborted");
}

class ReasoningStreamState {
  private spanId: string | null = null;
  private runOpen = false;
  private messageOpen = false;

  constructor(private readonly emit: (event: AgUiEvent) => void) {}

  appendDelta(delta: string): void {
    if (!delta) return;
    if (!this.spanId) {
      this.spanId = randomUUID();
    }
    if (!this.runOpen) {
      this.emit({ type: EventType.REASONING_START, messageId: this.spanId });
      this.runOpen = true;
    }
    if (!this.messageOpen) {
      this.emit({
        type: EventType.REASONING_MESSAGE_START,
        messageId: this.spanId,
        role: "reasoning",
      });
      this.messageOpen = true;
    }
    this.emit({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: this.spanId,
      delta,
    });
  }

  closeIfOpen(): void {
    if (this.messageOpen && this.spanId) {
      this.emit({ type: EventType.REASONING_MESSAGE_END, messageId: this.spanId });
      this.messageOpen = false;
    }
    if (this.runOpen && this.spanId) {
      this.emit({ type: EventType.REASONING_END, messageId: this.spanId });
      this.runOpen = false;
    }
    this.spanId = null;
  }
}

async function runStreamingA2A(
  client: Client,
  message: A2AMessage,
  abortSignal: AbortSignal,
  emit: (event: AgUiEvent) => void,
  initialTextMsgId: string,
  initialTextState: TextStreamState,
  reasoningState: ReasoningStreamState,
  onTaskId: (id: string) => void,
  onTerminal: () => void,
): Promise<{
  terminalReached: boolean;
  emittedAnyText: boolean;
  activeTaskId: string | null;
  textState: TextStreamState;
}> {
  let activeTaskId: string | null = null;
  let terminalReached = false;
  let emittedAnyText = false;
  let textMsgId = initialTextMsgId;
  let textState = initialTextState;
  const emittedToolCalls = new Set<string>();
  // Track artifact text lengths by artifactId to handle non-append full snapshots cleanly.
  const artifactTextLengths = new Map<string, number>();

  const emitText = (chunk: string) => {
    if (!chunk) return;
    reasoningState.closeIfOpen();
    emittedAnyText = true;
    textState.appendDelta(chunk);
  };

  const stream = client.sendMessageStream(
    {
      message,
      configuration: {
        acceptedOutputModes: ["text/plain", "application/json"],
        taskPushNotificationConfig: undefined,
        returnImmediately: false,
        historyLength: 0,
      },
      metadata: undefined,
      tenant: "",
    },
    { signal: abortSignal },
  );

  for await (const event of stream) {
    if (abortSignal.aborted) break;
    const payload = event.payload;
    if (!payload) continue;

    switch (payload.$case) {
      case "message": {
        const text = extractTextFromParts(payload.value.parts);
        emitText(text);
        terminalReached = true;
        onTerminal();
        break;
      }
      case "task": {
        const task = payload.value;
        activeTaskId = task.id;
        onTaskId(task.id);
        const state = task.status?.state;
        if (isInterruptedTaskState(state)) {
          terminalReached = true;
          onTerminal();
          throw new Error(formatTaskFailure(task));
        }
        if (isTerminalTaskState(state)) {
          terminalReached = true;
          onTerminal();
          if (state !== TaskState.TASK_STATE_COMPLETED) {
            throw new Error(formatTaskFailure(task));
          }
          if (!emittedAnyText) {
            emitText(extractTaskOutputText(task));
          }
        }
        break;
      }
      case "statusUpdate": {
        const update = payload.value;
        activeTaskId = update.taskId;
        onTaskId(update.taskId);
        const state = update.status?.state;

        const meta = update.metadata as Record<string, unknown> | undefined;
        const agnoEvent = typeof meta?.agno_event_type === "string" ? meta.agno_event_type : undefined;
        const tcId = typeof meta?.tool_call_id === "string" ? meta.tool_call_id : "";
        const tcName = typeof meta?.tool_name === "string" ? meta.tool_name : "";

        if (agnoEvent === "tool_call_started" && tcId && tcName && !emittedToolCalls.has(tcId)) {
          emittedToolCalls.add(tcId);
          textState.closeIfOpen();
          reasoningState.closeIfOpen();
          const rawArgs = meta?.tool_args;
          const argsDelta =
            typeof rawArgs === "string" && rawArgs.trim()
              ? rawArgs
              : JSON.stringify(rawArgs ?? {});
          emit({
            type: EventType.TOOL_CALL_START,
            toolCallId: tcId,
            toolCallName: tcName,
          });
          emit({
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: tcId,
            delta: argsDelta,
          });
          emit({
            type: EventType.TOOL_CALL_END,
            toolCallId: tcId,
          });
          break;
        }

        if (
          (agnoEvent === "tool_call_completed" || agnoEvent === "tool_call_error") &&
          tcId &&
          emittedToolCalls.has(tcId)
        ) {
          const rawResult =
            meta?.error ??
            meta?.result ??
            meta?.tool_result ??
            "(Executed on remote A2A agent — tool output is not included in the A2A stream)";
          emit({
            type: EventType.TOOL_CALL_RESULT,
            messageId: textMsgId,
            toolCallId: tcId,
            content: typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult),
          });
          textMsgId = randomUUID();
          textState = new TextStreamState(emit, textMsgId);
          break;
        }

        if (isInterruptedTaskState(state)) {
          terminalReached = true;
          onTerminal();
          throw new Error(formatTaskFailure(update));
        }
        if (isTerminalTaskState(state)) {
          terminalReached = true;
          onTerminal();
          if (state !== TaskState.TASK_STATE_COMPLETED) {
            throw new Error(formatTaskFailure(update));
          }
        }

        const statusText = extractTextFromParts(update.status?.message?.parts);
        if (statusText && (!terminalReached || !emittedAnyText)) {
          emitText(statusText);
        }
        break;
      }
      case "artifactUpdate": {
        const update = payload.value;
        activeTaskId = update.taskId;
        onTaskId(update.taskId);
        const artifact = update.artifact;
        if (!artifact) break;

        const text = extractTextFromParts(artifact.parts);
        if (!text) break;

        const artifactMeta = artifact.metadata as Record<string, unknown> | undefined;
        const isReasoning =
          artifact.name === "reasoning" ||
          artifactMeta?.agno_content_category === "reasoning" ||
          artifactMeta?.agno_event_type === "reasoning_content_delta";

        const artifactKey = artifact.artifactId || artifact.name || "default";
        let delta = "";
        if (update.append) {
          delta = text;
          artifactTextLengths.set(
            artifactKey,
            (artifactTextLengths.get(artifactKey) ?? 0) + text.length,
          );
        } else {
          const prevLen = artifactTextLengths.get(artifactKey) ?? 0;
          if (text.length > prevLen) {
            delta = text.slice(prevLen);
            artifactTextLengths.set(artifactKey, text.length);
          }
        }

        if (!delta) break;
        if (isReasoning) {
          reasoningState.appendDelta(delta);
        } else {
          emitText(delta);
        }
        break;
      }
    }
  }

  return { terminalReached, emittedAnyText, activeTaskId, textState };
}

class A2ABridgeAgent extends AbstractAgent {
  private cfg: A2AConfig;
  private log: Logger;

  constructor(cfg: A2AConfig, log: Logger) {
    super();
    this.cfg = cfg;
    this.log = log;
  }

  override clone(): A2ABridgeAgent {
    return attachBridgeConfig(super.clone() as A2ABridgeAgent, this.cfg);
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return createBridgeRunObservable(input, async ({ abortSignal, emit }) => {
      const prompt = lastUserText(input.messages);
      if (!prompt) {
        this.log.warn(
          { event: "empty_user_message", agentId: this.cfg.agentId },
          "no user message text found in input.messages",
        );
        return;
      }

      const fetchImpl = createA2AFetch(
        this.cfg.token,
        this.cfg.type,
        this.cfg.headerName,
      );

      const card: AgentCard = await fetchAgentCard(this.cfg.endpointUrl, fetchImpl);
      const client = await createA2AClientFromCard(
        card,
        this.cfg.endpointUrl,
        fetchImpl,
      );

      let activeTaskId: string | null = null;
      let terminalReached = false;
      const initialTextMsgId = randomUUID();
      let textState = new TextStreamState(emit, initialTextMsgId);
      const reasoningState = new ReasoningStreamState(emit);

      const onAbort = () => {
        if (activeTaskId && !terminalReached) {
          const taskIdToCancel = activeTaskId;
          void client
            .cancelTask({ id: taskIdToCancel, tenant: "", metadata: undefined })
            .catch((err) => {
              this.log.warn(
                {
                  event: "a2a_remote_cancel_failed",
                  taskId: taskIdToCancel,
                  err: err instanceof Error ? err.message : String(err),
                },
                "failed to cancel remote A2A task",
              );
            });
        }
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });

      const message: A2AMessage = {
        messageId: randomUUID(),
        contextId: input.threadId || "",
        taskId: "",
        role: Role.ROLE_USER,
        parts: [
          {
            content: { $case: "text", value: prompt },
            metadata: undefined,
            mediaType: "text/plain",
            filename: "",
          },
        ],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      };

      try {
        const supportsStreaming = card.capabilities?.streaming !== false;

        if (supportsStreaming) {
          const res = await runStreamingA2A(
            client,
            message,
            abortSignal,
            emit,
            initialTextMsgId,
            textState,
            reasoningState,
            (id) => {
              activeTaskId = id;
            },
            () => {
              terminalReached = true;
            },
          );
          textState = res.textState;

          if (res.activeTaskId && !res.terminalReached && !abortSignal.aborted) {
            await pollTaskUntilTerminal(
              client,
              res.activeTaskId,
              abortSignal,
              textState,
              () => res.emittedAnyText,
            );
            terminalReached = true;
          }
        } else {
          const result = await client.sendMessage(
            {
              message,
              configuration: {
                acceptedOutputModes: ["text/plain", "application/json"],
                taskPushNotificationConfig: undefined,
                returnImmediately: false,
                historyLength: 0,
              },
              metadata: undefined,
              tenant: "",
            },
            { signal: abortSignal },
          );

          if (!isTaskPayload(result)) {
            const text = extractTextFromParts(result.parts);
            if (text) textState.appendDelta(text);
            terminalReached = true;
          } else {
            activeTaskId = result.id;
            const state = result.status?.state;

            if (isInterruptedTaskState(state)) {
              terminalReached = true;
              throw new Error(formatTaskFailure(result));
            }
            if (isTerminalTaskState(state)) {
              terminalReached = true;
              if (state !== TaskState.TASK_STATE_COMPLETED) {
                throw new Error(formatTaskFailure(result));
              }
              const text = extractTaskOutputText(result);
              if (text) textState.appendDelta(text);
            } else {
              await pollTaskUntilTerminal(
                client,
                result.id,
                abortSignal,
                textState,
                () => false,
              );
              terminalReached = true;
            }
          }
        }

        reasoningState.closeIfOpen();
        textState.closeIfOpen();
      } finally {
        reasoningState.closeIfOpen();
        textState.closeIfOpen();
        abortSignal.removeEventListener("abort", onAbort);
      }
    });
  }
}

export const a2aChatHandler: IBackendChatHandler = {
  provider: "a2a",
  async buildAgent(ctx: ChatContext) {
    const resolved = await resolveBridgeCredential(ctx.credentialId);
    if (!resolved.ok) return resolved.response;

    const { baseUrl, apiKey, credential } = resolved.value;
    const endpointUrl = resolveA2AEndpointUrl(baseUrl, ctx.agentId);
    const log = childLogger({
      component: "a2a-chat",
      credentialId: ctx.credentialId,
      agentId: ctx.agentId,
    });

    return new A2ABridgeAgent(
      {
        credentialId: ctx.credentialId,
        agentId: ctx.agentId,
        endpointUrl,
        token: apiKey,
        type: credential.type,
        headerName: credential.headerName,
      },
      log,
    );
  },
};
