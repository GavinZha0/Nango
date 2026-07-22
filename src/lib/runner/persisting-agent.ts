/**
 * PersistingAgent — `AbstractAgent` decorator that tees AG-UI events
 * into `entity_run_event` and finalizes `entity_run` on terminal.
 *
 * See docs/runner-events.md.
 */

import "server-only";

import { AbstractAgent, EventType } from "@/lib/copilot/index.server";
import type { AgUiEvent, BaseEvent, RunAgentInput } from "@/lib/copilot/index.server";
import { Observable } from "rxjs";

import { childLogger } from "@/lib/observability/logger";
import type { EntityRunEventType, EntityRunStatus } from "@/lib/db/schema";
import { redactSensitiveText } from "@/lib/agent-pipeline/output-redaction";
import { recordEvent, finalizeRun } from "./event-store";
import { RunSequenceRegistry } from "./sequence-registry";

const log = childLogger({ component: "persisting-agent" });

/** Max wait for queued event writes + terminal `entity_run` UPDATE
 *  before closing the SSE response — bounds blast radius if the DB
 *  is hung. Drain normally completes in a few ms. */
const FINALIZE_DRAIN_TIMEOUT_MS = 5_000;

interface PersistingAgentConfig {
  inner: AbstractAgent;
  runId: string;
  /** Starting sequence number for events emitted by this agent. Set
   *  when dispatch has already written rows at seq 0..N-1 so the
   *  agent picks up at seq N without PRIMARY KEY collisions. */
  startSeq?: number;
}

/** CONTRACT: `startTs` is captured at the first event of a segment
 *  so `entity_run_event.ts` reflects first-token time (accurate TTFT). */
interface PendingMessage {
  messageId: string;
  role: string;
  text: string;
  startTs: Date;
}

interface PendingReasoning {
  messageId: string;
  text: string;
  startTs: Date;
}

/** Coerce loosely-typed AG-UI fields so the persistence path stays total. */
function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export class PersistingAgent extends AbstractAgent {
  constructor(public readonly cfg: PersistingAgentConfig) {
    super();
  }

  /** Re-attach config + clone inner so CopilotRuntime's per-request
   *  clone preserves the wrapping. */
  clone(): this {
    const cloned = super.clone() as this;
    (cloned as unknown as { cfg: PersistingAgentConfig }).cfg = {
      inner: this.cfg.inner.clone(),
      runId: this.cfg.runId,
      startSeq: this.cfg.startSeq,
    };
    return cloned;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    let seq = this.cfg.startSeq ?? 0;
    let lastError: string | null = null;
    let finalized = false;

    const runId = this.cfg.runId;
    if (runId) {
      RunSequenceRegistry.set(runId, seq);
    }

    // Streaming triplets (TEXT / REASONING / TOOL_CALL_*) are
    // buffered here and flushed as one row at the natural boundary.
    let pendingMessage: PendingMessage | null = null;
    let pendingReasoning: PendingReasoning | null = null;
    interface PendingToolCall {
      toolName: string;
      args: string;
      startTs: Date;
    }
    const pendingToolCalls = new Map<string, PendingToolCall>();

    let droppedEvents = 0;

    // Every `recordEvent` write is queued so finalize can await
    // drain — required so a synchronous reconnect doesn't see a
    // still-`running` row or a partial timeline.
    const pendingWrites: Promise<void>[] = [];

    const persist = (
      type: EntityRunEventType,
      payload: unknown,
      ts?: Date,
    ): void => {
      const seqNow = runId ? (RunSequenceRegistry.get(runId) ?? seq) : seq;
      seq = seqNow + 1;
      if (runId) {
        RunSequenceRegistry.set(runId, seq);
      }
      const p = recordEvent(runId, seqNow, type, payload, ts).catch(
        (err: unknown) => {
          droppedEvents += 1;
          log.error(
            {
              runId,
              seq: seqNow,
              type,
              droppedEvents,
              err: err instanceof Error ? err.message : String(err),
            },
            "failed to persist run event — timeline may be incomplete",
          );
        },
      );
      pendingWrites.push(p);
    };

    const flushMessage = (): void => {
      if (!pendingMessage) return;
      const { messageId, role, text, startTs } = pendingMessage;
      persist("message", { messageId, role, text: redactSensitiveText(text) }, startTs);
      pendingMessage = null;
    };

    const flushReasoning = (): void => {
      if (!pendingReasoning) return;
      const { messageId, text, startTs } = pendingReasoning;
      persist("reasoning", { messageId, text: redactSensitiveText(text) }, startTs);
      pendingReasoning = null;
    };

    const flushPending = (): void => {
      flushMessage();
      flushReasoning();
    };

    /**
     * CONTRACT: idempotent terminal write — first caller wins.
     * Always flushes pending buffers first so partial text on
     * cancelled runs survives. Awaits queued event writes and the
     * `finalizeRun` UPDATE; `Promise.allSettled` so a single event
     * failure doesn't block the terminal write. Capped by
     * {@link FINALIZE_DRAIN_TIMEOUT_MS}.
     */
    const finalizeOnce = async (
      status: EntityRunStatus,
      fields: { errorMessage?: string } = {},
    ): Promise<void> => {
      if (finalized) return;
      finalized = true;
      if (runId) {
        RunSequenceRegistry.delete(runId);
      }
      flushPending();

      const drain = (async (): Promise<void> => {
        await Promise.allSettled(pendingWrites);
        try {
          const cleanFields = fields.errorMessage
            ? { ...fields, errorMessage: redactSensitiveText(fields.errorMessage) }
            : fields;
          await finalizeRun(runId, status, cleanFields);
        } catch (e: unknown) {
          log.error(
            { runId, err: e instanceof Error ? e.message : String(e) },
            "failed to finalize run",
          );
        }
      })();

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(() => {
          log.error(
            {
              runId,
              status,
              pending: pendingWrites.length,
              timeoutMs: FINALIZE_DRAIN_TIMEOUT_MS,
            },
            "finalize drain timed out — closing SSE with possibly inconsistent DB state",
          );
          resolve();
        }, FINALIZE_DRAIN_TIMEOUT_MS);
      });

      try {
        await Promise.race([drain, timeout]);
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }
    };

    return new Observable<BaseEvent>((subscriber) => {
      const handleEvent = (rawEv: BaseEvent): void => {
          // Boundary cast: `inner.run()` is typed as BaseEvent but
          // every event we care about is in `AgUiEvent`. Niche events
          // hit `default` and are dropped harmlessly.
          const ev = rawEv as AgUiEvent;
          switch (ev.type) {
            case EventType.RUN_STARTED: {
              flushPending();
              persist("started", ev);
              break;
            }

            case EventType.TEXT_MESSAGE_START: {
              flushMessage();
              pendingMessage = {
                messageId: ev.messageId,
                role: ev.role,
                text: "",
                startTs: new Date(),
              };
              break;
            }

            case EventType.TEXT_MESSAGE_CONTENT:
            case EventType.TEXT_MESSAGE_CHUNK: {
              const messageId = asString(ev.messageId);
              const delta = asString(ev.delta);
              if (pendingMessage && pendingMessage.messageId === messageId) {
                pendingMessage.text += delta;
              } else {
                // New messageId → flush old, start new. CHUNK events
                // have optional `role`; fall back to assistant.
                flushMessage();
                const role: string =
                  ev.type === EventType.TEXT_MESSAGE_CHUNK
                    ? (ev.role ?? "assistant")
                    : "assistant";
                pendingMessage = {
                  messageId,
                  role,
                  text: delta,
                  startTs: new Date(),
                };
              }
              break;
            }

            case EventType.TEXT_MESSAGE_END: {
              flushMessage();
              break;
            }

            case EventType.REASONING_MESSAGE_START: {
              flushReasoning();
              pendingReasoning = {
                messageId: ev.messageId,
                text: "",
                startTs: new Date(),
              };
              break;
            }

            case EventType.REASONING_MESSAGE_CONTENT: {
              const messageId = ev.messageId;
              const delta = ev.delta;
              if (
                pendingReasoning
                && pendingReasoning.messageId === messageId
              ) {
                pendingReasoning.text += delta;
              } else {
                flushReasoning();
                pendingReasoning = {
                  messageId,
                  text: delta,
                  startTs: new Date(),
                };
              }
              break;
            }

            case EventType.REASONING_MESSAGE_END: {
              flushReasoning();
              break;
            }

            case EventType.TOOL_CALL_START: {
              // Compose the chunk row at END — name + full args.
              pendingToolCalls.set(ev.toolCallId, {
                toolName: ev.toolCallName,
                args: "",
                startTs: new Date(),
              });
              break;
            }

            case EventType.TOOL_CALL_ARGS: {
              const entry = pendingToolCalls.get(ev.toolCallId);
              // Only accumulate if we saw a START — orphaned ARGS
              // would create an entry with no toolName.
              if (entry !== undefined) {
                entry.args += ev.delta;
              }
              break;
            }

            case EventType.TOOL_CALL_END: {
              flushPending();
              const entry = pendingToolCalls.get(ev.toolCallId);
              if (entry !== undefined) {
                persist(
                  "tool_call_chunk",
                  {
                    toolCallId: ev.toolCallId,
                    toolName: entry.toolName,
                    args: entry.args,
                  },
                  entry.startTs,
                );
                pendingToolCalls.delete(ev.toolCallId);
              }
              break;
            }

            // TODO: handle AG-UI `TOOL_CALL_CHUNK` (single-event
            // OpenAI-streaming variant) when an upstream emits it.

            case EventType.TOOL_CALL_RESULT: {
              flushPending();
              persist("tool_call_result", {
                toolCallId: ev.toolCallId,
                content: ev.content,
              });
              break;
            }

            case EventType.RUN_FINISHED: {
              flushPending();
              persist("finished", ev);
              break;
            }

            case EventType.RUN_ERROR: {
              flushPending();
              lastError = ev.message;
              persist("error", ev);
              break;
            }

            default:
              return;
          }
      };

      // CONTRACT: manual subscription so `subscriber.complete()` is
      // sequenced AFTER `finalizeOnce()` — the terminal status flip
      // must be visible before the SSE stream closes, otherwise a
      // synchronous reconnect surfaces as a blank chat.
      const innerSub = this.cfg.inner.run(input).subscribe({
        next: (rawEv: BaseEvent) => {
          handleEvent(rawEv);
          subscriber.next(rawEv);
        },
        error: (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          void finalizeOnce("failed", { errorMessage: message }).finally(() => {
            subscriber.error(err);
          });
        },
        complete: () => {
          const status = lastError === null ? "succeeded" : "failed";
          const fields = lastError === null ? {} : { errorMessage: lastError };
          void finalizeOnce(status, fields).finally(() => {
            subscriber.complete();
          });
        },
      });

      // Unsubscribe path (Stop, abort, teardown). RxJS teardown is
      // synchronous so we can't await the drain — fire-and-forget.
      return () => {
        innerSub.unsubscribe();
        if (finalized) return;
        log.info(
          { runId },
          "run subscriber unsubscribed before completion; marking cancelled",
        );
        void finalizeOnce("cancelled", { errorMessage: "client_aborted" });
      };
    });
  }
}
