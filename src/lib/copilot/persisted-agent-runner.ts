import "server-only";

/**
 * AgentRunner that backs CopilotKit's `/run` and `/connect`
 * endpoints with Nango's `entity_run_event` table.
 *
 * See docs/persisted-agent-runner-migration.md.
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
      // Fail fast — silently dropping persistence is worse than 500.
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
    // CRITICAL: `AbstractAgent.runAgent` reads conversation state
    // off `this.messages` / `this.state` / `this.threadId`, NOT off
    // `parameters`. Copy from the inner agent so the wrap is
    // transparent — otherwise the LLM sees an empty conversation.
    wrapped.setMessages(req.agent.messages);
    wrapped.setState(req.agent.state);
    wrapped.threadId = req.agent.threadId;
    return this.inner.run({ ...req, agent: wrapped });
  }

  /**
   * CONTRACT: `/connect` is ALWAYS a DB-driven history replay,
   * regardless of whether a run on this thread is live. Bridging
   * to `InMemoryAgentRunner.connect()` here would cause duplicate
   * tool-call rendering on subsequent chart turns. See
   * docs/persisted-agent-runner-migration.md and
   * docs/data-visualization.md.
   */
  connect(req: AgentRunnerConnectRequest): Observable<BaseEvent> {
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
