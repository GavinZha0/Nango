/**
 * PersistingAgent — `AbstractAgent` decorator that tees AG-UI events
 */

import "server-only";

import { AbstractAgent, EventType } from "@/lib/copilot/index.server";
import type { AgUiEvent, BaseEvent, RunAgentInput } from "@/lib/copilot/index.server";
import { Observable } from "rxjs";

import { childLogger } from "@/lib/observability/logger";
import type { EntityRunEventType, EntityRunStatus } from "@/lib/db/schema";
import { recordEvent, finalizeRun } from "./event-store";

const log = childLogger({ component: "persisting-agent" });

/**
 * Maximum time we'll wait for queued `recordEvent` writes + the
 * terminal `entity_run` UPDATE to drain before closing the SSE
 * response. If the DB is hung or unreachable we'd rather close the
 * stream than wedge the client indefinitely; the consequence of
 * timing out is that a subsequent `/connect` on the same thread may
 * see partial events / a still-`running` status row, which manifests
 * as the same blank-chat regression this drain was added to fix.
 * In practice the drain completes within a few ms.
 */
const FINALIZE_DRAIN_TIMEOUT_MS = 5_000;

interface PersistingAgentConfig {
  inner: AbstractAgent;
  runId: string;
  /** Starting sequence number for events emitted by this agent.
   *  Default 0. Set this when the dispatch layer has already
   *  written rows at seq 0..N-1 (e.g. `degraded` build-
   *  time events) so the agent's stream picks up at seq N without
   *  PRIMARY KEY collisions. */
  startSeq?: number;
}

/** CONTRACT: `startTs` is captured at the moment we first see the
 *  segment (TEXT_MESSAGE_START / first CHUNK / etc.) so the row's
 *  `entity_run_event.ts` reflects first-token time, not the end of
 *  the streaming window. Critical for accurate TTFT — see
 *  `docs/runner-events.md` §"TTFT and event timestamps". */
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

/** Read a string field defensively — AG-UI events are typed loosely
 *  in the SDK and the bridge layers occasionally hand us nullable
 *  values. Coercing here keeps the persistence path total. */
function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export class PersistingAgent extends AbstractAgent {
  constructor(public readonly cfg: PersistingAgentConfig) {
    super();
  }

  /** QUIRK: re-attach config + clone inner agent so CopilotRuntime's
   *  per-request clone preserves the wrapping. */
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

    // Coalescing state
    // CONTRACT: `pendingMessage`, `pendingReasoning`, and
    // `pendingToolCalls` are the in-memory accumulators. AG-UI's
    // streaming event triplets (TEXT / REASONING / TOOL_CALL_*)
    // are buffered here and flushed as one row at the natural
    // boundary (END / next-segment / run-finalize). Every other
    // AG-UI event is either persisted immediately (after flushing
    // pending) or dropped (transport-only framing like
    // MESSAGES_SNAPSHOT, STATE_*).
    let pendingMessage: PendingMessage | null = null;
    let pendingReasoning: PendingReasoning | null = null;
    // @see docs/runner-events.md#31-in-memory-accumulators
    interface PendingToolCall {
      toolName: string;
      args: string;
      startTs: Date;
    }
    const pendingToolCalls = new Map<string, PendingToolCall>();

    let droppedEvents = 0;

    // CONTRACT: every `recordEvent` write is queued here so we can
    // await drain at run finalization. Without this, the SSE stream
    // would close while `recordEvent` rows are still in-flight, and
    // a client that immediately reconnects (CopilotKit's recursive
    // `runAgent` continuation after a frontend tool call does
    // exactly this) would call `reconstructFromDb` against an
    // inconsistent timeline — missing events, or a row whose
    // `entity_run.status` is still 'running'. The terminal
    // `entity_run` UPDATE is also awaited inside `drainAndFinalize`
    // so the status flip to 'succeeded'/'failed' is visible before
    // we close the stream. @see docs/runner-events.md
    const pendingWrites: Promise<void>[] = [];

    const persist = (
      type: EntityRunEventType,
      payload: unknown,
      ts?: Date,
    ): void => {
      const seqNow = seq;
      seq += 1;
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
      persist("message", { messageId, role, text }, startTs);
      pendingMessage = null;
    };

    const flushReasoning = (): void => {
      if (!pendingReasoning) return;
      const { messageId, text, startTs } = pendingReasoning;
      persist("reasoning", { messageId, text }, startTs);
      pendingReasoning = null;
    };

    const flushPending = (): void => {
      flushMessage();
      flushReasoning();
    };

    /**
     * CONTRACT: idempotent terminal write — first caller wins. We
     * ALWAYS drain pending buffers before writing the terminal row
     * so partial text from cancelled runs survives.
     *
     * Awaits queued `recordEvent` writes and the terminal
     * `finalizeRun` UPDATE so that callers (the new-Observable
     * subscriber below) can sequence `subscriber.complete()` AFTER
     * the DB is consistent. We use `Promise.allSettled` (not `all`)
     * because individual `recordEvent` failures are already logged
     * by `persist` and shouldn't block the terminal write.
     *
     * Capped by `FINALIZE_DRAIN_TIMEOUT_MS` so a hung DB doesn't
     * make the SSE stream hang open forever.
     */
    const finalizeOnce = async (
      status: EntityRunStatus,
      fields: { errorMessage?: string } = {},
    ): Promise<void> => {
      if (finalized) return;
      finalized = true;
      flushPending();

      const drain = (async (): Promise<void> => {
        await Promise.allSettled(pendingWrites);
        try {
          await finalizeRun(runId, status, fields);
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
          // BOUNDARY CAST: `inner.run()` returns `Observable<BaseEvent>`
          // per the upstream `AbstractAgent` contract, but in practice
          // every event we receive is one of the concrete variants in
          // {@link AgUiEvent}. Cast once at the boundary so the switch
          // below narrows on `ev.type` (an `EventType` enum value)
          // without per-case `as BaseEvent & {...}` casts. Niche events
          // outside `AgUiEvent` (e.g. STATE_SNAPSHOT) hit the default
          // arm and are dropped harmlessly.
          // @see docs/runner-events.md §11
          const ev = rawEv as AgUiEvent;
          // @see docs/runner-events.md#stage-2--coalescing
          switch (ev.type) {
            case EventType.RUN_STARTED: {
              flushPending();
              persist("started", ev);
              break;
            }

            case EventType.TEXT_MESSAGE_START: {
              // @see docs/runner-events.md#32-boundary-semantics
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
                // Different (or no prior) messageId → flush old, start new.
                // CHUNK events have optional `role`; fall back to assistant.
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

            // @see docs/runner-events.md#44-why-two-rows-per-tool-call
            case EventType.TOOL_CALL_START: {
              // Don't write yet — the chunk row is composed at END
              // once we have name + full args together. flushPending
              // is also deferred so any pre-tool assistant text
              // remains coalesced through the call boundary, which
              // is harmless because nothing else can interleave a
              // tool-call's own START / ARGS / END.
              pendingToolCalls.set(ev.toolCallId, {
                toolName: ev.toolCallName,
                args: "",
                startTs: new Date(),
              });
              break;
            }

            case EventType.TOOL_CALL_ARGS: {
              const entry = pendingToolCalls.get(ev.toolCallId);
              // CONTRACT: only accumulate if we saw a START — drop
              // orphaned ARGS to avoid an entry with no toolName.
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

            // TODO: when an upstream provider eventually emits AG-UI
            // `TOOL_CALL_CHUNK` (the OpenAI-streaming-style single-
            // event variant), accumulate it into the same
            // pendingToolCalls map and flush at the next boundary
            // (next non-chunk event with a different toolCallId, the
            // matching TOOL_CALL_RESULT, or RUN_FINISHED). Today
            // none of agno / Mastra / Dify emit it, so dropping is
            // safe; revisit when the test fails.

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

            // @see docs/runner-events.md
            default:
              return;
          }
      };

      // CONTRACT: we use a manual subscription (rather than the
      // pipe(tap, finalize) combo this used to use) so that we can
      // sequence `subscriber.complete()` AFTER `finalizeOnce()`
      // resolves. The terminal `entity_run.status` UPDATE must be
      // visible BEFORE the SSE stream closes — otherwise a client
      // that reconnects synchronously (CopilotKit's recursive
      // `runAgent` after a frontend tool call) hits a still-
      // `running` row and `reconstructFromDb` filters it out,
      // surfacing as a blank chat. @see docs/runner-events.md
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

      // @see docs/runner-events.md#33-subscriber-teardown
      // Unsubscribe path (client `Stop`, request abort, parent
      // subscription teardown). RxJS teardown is synchronous, so
      // unlike the complete/error paths we CANNOT await the drain
      // here — we just kick it off and let it run. Acceptable
      // because aborted runs aren't immediately reconnected; the
      // user sees the `cancelled` status whenever they next refresh.
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
