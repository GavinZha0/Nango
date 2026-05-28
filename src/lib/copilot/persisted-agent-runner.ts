import "server-only";

/**
 * AgentRunner implementation that backs CopilotKit's `/run` and
 * `/connect` endpoints with Nango's `entity_run_event` table.
 *
 * Architecture:
 *  - `run()` delegates to an internal `InMemoryAgentRunner` after
 *    wrapping the inner agent with `PersistingAgent` (which tees AG-UI
 *    events into the DB while they flow live to the SSE response).
 *  - `connect()` ALWAYS reconstructs from the DB via
 *    {@link reconstructFromDb}. We do NOT fall back to
 *    `InMemoryAgentRunner.connect()` even when a live run exists on
 *    the thread; that bridge has a duplicate-emission bug (its
 *    dedup keys on `messageId`, but AG-UI's `TOOL_CALL_*` events
 *    have only `toolCallId`, so tool-call events leak through and
 *    every chart card on the thread renders multiple times after a
 *    subsequent chart turn). The DB is our single source of truth
 *    for replay; in-flight runs are filtered out at the SQL layer
 *    and their events flow to the client via the live `/run` SSE
 *    response instead.
 *
 * Why this layer at all: CopilotKit's default `InMemoryAgentRunner`
 * keeps all historic events in `globalThis.GLOBAL_STORE` for the
 * lifetime of the process. After a server restart the store is empty
 * and `/connect` returns nothing for historical threads, which the
 * client previously papered over with a separate REST-backed
 * hydration hook. Plugging this DB-backed runner makes `/connect`
 * itself the source of truth for history.
 *
 * KNOWN LIMITATION: the inner `InMemoryAgentRunner.GLOBAL_STORE`
 * still accumulates events per-run for the process lifetime. The
 * `run()` path needs that store for the SSE pubsub + pre-finalize
 * pump; we just never read it back from `connect()`. Sizing for
 * Nango's single-node multi-tenant deployment is acceptable up to
 * ~100 active users; if memory pressure ever appears, evict
 * `GLOBAL_STORE` entries when their thread is no longer being
 * actively chatted with.
 *
 * @see docs/persisted-agent-runner-migration.md
 */

import type { Observable } from "rxjs";

import {
  AgentRunner,
  InMemoryAgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  type BaseEvent,
} from "@/lib/copilot/index.server";
import type { childLogger } from "@/lib/observability/logger";
import { PersistingAgent } from "@/lib/runner/persisting-agent";

import { reconstructFromDb } from "./event-reconstruction";

export interface PersistedAgentRunnerConfig {
  /** Owner of every thread this runner may handle. Used to scope the
   *  DB query in {@link reconstructFromDb}. Per-request construction
   *  is expected — never share a runner across owners. */
  ownerId: string;

  /** Required when this runner handles a `/run` request — the
   *  `PersistingAgent` wrap needs an id to tag persisted rows. Not
   *  required for connect-only construction (e.g. bookkeeping fast
   *  paths or pure history reads). */
  runId?: string;

  /** Seq offset for the first event persisted by this run. Defaults
   *  to 0. Set this when the dispatch layer has already written rows
   *  at seq 0..N-1 (e.g. `degraded` build-time events). */
  startSeq?: number;

  log: ReturnType<typeof childLogger>;
}

export class PersistedAgentRunner extends AgentRunner {
  /** Shared in-memory machinery: pub/sub for live runs, isRunning
   *  bookkeeping, abort. We never read its historicRuns for replay —
   *  that goes to DB. */
  private readonly inner = new InMemoryAgentRunner();

  constructor(private readonly cfg: PersistedAgentRunnerConfig) {
    super();
  }

  run(req: AgentRunnerRunRequest): Observable<BaseEvent> {
    if (!this.cfg.runId) {
      // Fail fast — silently dropping persistence here would be far
      // worse than a 500 the operator can see in logs.
      throw new Error(
        "PersistedAgentRunner.run() requires `runId` in config — caller " +
          "must create an entity_run row before invoking run().",
      );
    }
    const wrapped = new PersistingAgent({
      inner: req.agent,
      runId: this.cfg.runId,
      startSeq: this.cfg.startSeq ?? 0,
    });
    // CRITICAL: AbstractAgent.runAgent() reads `this.messages` /
    // `this.state` / `this.threadId` (via `prepareRunAgentInput`) and
    // ignores `parameters.messages`. CopilotKit's handle-run.ts
    // populates these fields on the agent it hands to the runner
    // (lines 54-56: `agent.setMessages(input.messages)` etc.). In
    // memory mode the agent is already wrapped with PersistingAgent
    // before that handler runs, so the state lands on the wrapper.
    // Here we wrap AFTER the handler, so the wrapper starts with
    // empty messages and the LLM sees an empty conversation. Copy
    // the state across so the wrap is transparent.
    wrapped.setMessages(req.agent.messages);
    wrapped.setState(req.agent.state);
    wrapped.threadId = req.agent.threadId;
    return this.inner.run({ ...req, agent: wrapped });
  }

  connect(req: AgentRunnerConnectRequest): Observable<BaseEvent> {
    // CONTRACT: `/connect` is ALWAYS a DB-driven history replay,
    // regardless of whether a run on this thread is currently live.
    //
    // CopilotChat's `connect-on-thread` effect calls
    // `copilotkit.connectAgent({agent})` whose first step is
    // `agent.setMessages([])` — i.e. it WIPES the local agent's
    // messages before the connect stream starts, on the assumption
    // that the stream will fully repopulate them. If we return an
    // empty stream here (or any partial subset), the chat UI is left
    // with `agent.messages = []` and the user sees a blank chat
    // until something else triggers a re-render that re-runs
    // `connect()`.
    //
    // `reconstructFromDb` already excludes in-flight runs via its
    // `inArray(status, ["succeeded", "failed", "cancelled"])` filter
    // (see `fetchRuns` in event-reconstruction.ts), so we can't
    // accidentally emit a half-persisted in-flight RUN_FINISHED.
    // That's the only safety property the previous "skip when
    // in-flight" guard added — and the cost of that guard
    // (`agent.setMessages([])` followed by an empty `/connect`)
    // produces the blank-chat regression. The terminal-only filter
    // is sufficient.
    //
    // We do NOT bridge `InMemoryAgentRunner.connect()` even when a
    // live run exists on the thread: that bridge dedupes by
    // `messageId` but AG-UI's `TOOL_CALL_*` events carry only
    // `toolCallId`, so tool-call events leak through and every chart
    // card renders multiple times after a subsequent chart turn.
    // DB-driven replay is idempotent against live state because
    // every event PersistingAgent emits is also persisted with a
    // stable id; the client-side apply pipeline dedupes the replay
    // against its own state.
    //
    // @see docs/data-visualization.md §6.4 ("Bug B" diagnosis)
    return reconstructFromDb({
      threadId: req.threadId,
      ownerId: this.cfg.ownerId,
      log: this.cfg.log,
    });
  }

  isRunning(req: AgentRunnerIsRunningRequest): Promise<boolean> {
    return this.inner.isRunning(req);
  }

  stop(req: AgentRunnerStopRequest): Promise<boolean | undefined> {
    return this.inner.stop(req);
  }
}
