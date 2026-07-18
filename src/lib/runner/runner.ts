/**
 * Runner — execution kernel implementation.
 *
 * See docs/orchestrator.md and docs/runner-events.md.
 */

import "server-only";

import { randomUUID } from "node:crypto";

import type {
  AbstractAgent,
  AgUiEvent,
  BaseEvent,
  RunAgentInput,
} from "@/lib/copilot/index.server";
import {
  EventType,
  BuiltInAgent,
} from "@/lib/copilot/index.server";
import { NextResponse } from "next/server";

import { runWithAgents } from "@/lib/backends/runtime.server";
import { getChatHandler } from "@/lib/backends/registry.server";
import { ApiError } from "@/lib/http/route-handlers";
import {
  isAgentVisibleTo,
  listVisibleAgentIds,
} from "@/lib/access/agent-visibility";
import { getConfigMs } from "@/lib/config";
import { childLogger } from "@/lib/observability/logger";
import { flushLangfuse, withTrace } from "@/lib/observability/langfuse";
import type { ChatContext, EntityKind } from "@/lib/backends/types";

import {
  buildBuiltinAgents,
  classifyBuiltinPath,
  releaseBuiltinBorrows,
  recordCapabilityDegradations,
  type BorrowRecord,
  type CapabilityDegradation,
} from "./dispatch/builtin";
import type { ParentRunIdHolder } from "./supervisor-tools.server";
import {
  ORCHESTRATION_MODE_HEADER,
  resolveOrchestrationMode,
} from "@/lib/orchestration/modes";
import { recordEvent, recordRunStart, finalizeRun } from "./event-store";
import { extractRunInput } from "./extract-run-input";
import { injectServerUserId } from "./inject-user-id";
import { PersistingAgent } from "./persisting-agent";
import { PersistedAgentRunner } from "@/lib/copilot/persisted-agent-runner";
import { publish } from "./event-bus";
import { resolveTranscriptionService } from "@/lib/voice/transcription.server";
import { db } from "@/lib/db";
import { BuiltinAgentTable } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { previewBody, recordRunNotification } from "./notifications";
import type {
  ProgrammaticRunResult,
  Runner,
  RunBuiltinChatRequestArgs,
  StartRunInput,
} from "./types";

const log = childLogger({ component: "runner" });

/** True iff this is a real `/run` dispatch (not `/connect` or
 *  `/stop`). Non-run paths skip the `entity_run` lifecycle. `/info`
 *  and `/threads/*` bookkeeping are handled in the route layer and
 *  never reach `runChatRequest`. */
function isRunRequest(request: Request): boolean {
  return (
    request.method === "POST" &&
    /\/agent\/[^/]+\/run\b/.test(new URL(request.url).pathname)
  );
}

/** True iff the request targets the SSE `/connect` endpoint.
 *  Connect is a read-only resume (no new run row) but still attaches
 *  `PersistedAgentRunner` so `.connect()` replays from
 *  `entity_run_event` after a server restart. */
function isConnectRequest(request: Request): boolean {
  return /\/agent\/[^/]+\/connect\b/.test(new URL(request.url).pathname);
}

/** Persist the user prompt as a `message` event so history replay
 *  emits a TEXT_MESSAGE_* the client deduplicates against its own
 *  state. Returns the next seq. No-op when `task` is empty. */
async function recordUserMessage(
  runId: string,
  startSeq: number,
  task: string,
  userMessageId: string | undefined,
): Promise<number> {
  const trimmed = task.trim();
  if (trimmed.length === 0) return startSeq;
  const messageId = userMessageId ?? `${runId}.user`;
  await recordEvent(runId, startSeq, "message", {
    messageId,
    role: "user",
    text: task,
  });
  return startSeq + 1;
}

class RunnerImpl implements Runner {
  async runChatRequest(
    request: Request,
    input: StartRunInput,
  ): Promise<Response> {
    // CONTRACT: backend only. Built-in chat → `runBuiltinChatRequest`.
    if (!input.credentialId) {
      return NextResponse.json(
        { error: "Runner.runChatRequest: credentialId required (backend chat only)." },
        { status: 400 },
      );
    }

    const credentialId = input.credentialId;

    // Missing kind on backend dispatch is a programmer error.
    if (!input.entityKind) {
      return NextResponse.json(
        {
          error:
            "Runner.runChatRequest: entityKind is required for backend dispatch.",
        },
        { status: 400 },
      );
    }
    const kind: EntityKind = input.entityKind;
    const ctx: ChatContext = {
      credentialId,
      agentId: input.entityId,
      agentKind: kind,
      userId: input.ownerId,
      endpoint: "/api/copilotkit",
    };

    const provider = await this.providerForCredential(credentialId);
    const handler = getChatHandler(provider);
    if (!handler) {
      return NextResponse.json(
        { error: `Runner: no chat handler registered for credential ${credentialId}.` },
        { status: 503 },
      );
    }

    const built = await handler.buildAgent(ctx);
    if (built instanceof Response) {
      // Credential / config error from the handler — no run row.
      return built;
    }
    const innerAgent: AbstractAgent = built;

    // Non-run paths (/connect, /stop) skip the entity_run lifecycle.
    // /connect attaches PersistedAgentRunner so history replay works.
    if (!isRunRequest(request)) {
      if (isConnectRequest(request)) {
        ctx.runner = new PersistedAgentRunner({
          ownerId: input.ownerId,
          log,
        });
      }
      try {
        return await runWithAgents(request, {
          agents: { [ctx.agentId]: innerAgent },
          endpoint: ctx.endpoint,
          runner: ctx.runner,
          trimMessages: true,
          entitySource: "backend",
          diag: {
            agentId: ctx.agentId,
            credentialId: ctx.credentialId,
            userId: ctx.userId,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          { event: "bookkeeping_error", credentialId, entityId: input.entityId, error: message },
          "bookkeeping request failed",
        );
        throw err;
      }
    }

    // CONTRACT: body threadId is the AG-UI source of truth.
    const peek = await extractRunInput(request);
    const task = input.task || peek.task;
    const threadId = input.threadId ?? peek.threadId;
    const run = await recordRunStart({
      parentRunId: input.parentRunId,
      threadId,
      initiator: input.initiator,
      entityId: input.entityId,
      entityKind: kind,
      entitySource: "backend",
      credentialId,
      mode: input.mode,
      task,
      context: input.context,
      params: input.params,
      ownerId: input.ownerId,
      createdBy: input.createdBy,
      deadline: input.deadline,
    });

    log.info(
      {
        event: "run_started",
        runId: run.id,
        entityId: input.entityId,
        entityKind: kind,
        entitySource: "backend",
        threadId: input.threadId,
        ownerId: input.ownerId,
      },
      "entity_run started",
    );

    // Continuation vs normal chat — same dichotomy as
    // `runBuiltinChatRequest`. Backend agents rarely use frontend
    // tools (their backend owns session memory) but kept symmetric.
    let startSeq: number;
    if (peek.triggeringToolResults.length > 0) {
      startSeq = 0;
      for (const tr of peek.triggeringToolResults) {
        await recordEvent(run.id, startSeq, "tool_call_result", tr);
        startSeq += 1;
      }
    } else {
      startSeq = await recordUserMessage(
        run.id,
        0,
        task,
        peek.userMessageId,
      );
    }

    // PersistedAgentRunner wraps the inner agent with PersistingAgent
    // inside .run() AND owns history replay on .connect().
    ctx.runner = new PersistedAgentRunner({
      runId: run.id,
      ownerId: input.ownerId,
      startSeq,
      log,
    });

    const sealed = await injectServerUserId(request, input.ownerId);

    try {
      return await runWithAgents(sealed, {
        agents: { [ctx.agentId]: innerAgent },
        endpoint: ctx.endpoint,
        runner: ctx.runner,
        trimMessages: true,
        entitySource: "backend",
        diag: {
          agentId: ctx.agentId,
          credentialId: ctx.credentialId,
          userId: ctx.userId,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await finalizeRun(run.id, "failed", { errorMessage: message });
      throw err;
    }
  }

  /** Lazy import — keeps `credential-lookup` off the runner-types graph. */
  private async providerForCredential(credentialId: string): Promise<string | null> {
    const { getCredentialConfigById } = await import("@/lib/credentials/lookup");
    const cfg = await getCredentialConfigById(credentialId);
    return cfg?.provider ?? null;
  }

  async runBuiltinChatRequest(
    request: Request,
    args: RunBuiltinChatRequestArgs,
  ): Promise<Response> {
    const { userId, requestId, log: requestLog } = args;
    const url: URL = new URL(request.url);
    const start: number = Date.now();
    const classified = classifyBuiltinPath(url.pathname);

    let agentIds: string[];
    if (classified) {
      const allowed: boolean = await isAgentVisibleTo(classified.agentId, userId);
      if (!allowed) {
        requestLog.warn(
          {
            event: "auth",
            outcome: "forbidden",
            userId,
            agentId: classified.agentId,
            durationMs: Date.now() - start,
          },
          "agent not visible to user",
        );
        throw new ApiError("NOT_FOUND", 404, "Not found");
      }
      agentIds = [classified.agentId];
    } else {
      agentIds = await listVisibleAgentIds(userId);
      if (agentIds.length === 0) {
        requestLog.info(
          { event: "no_agents", userId, durationMs: Date.now() - start },
          "no built-in agents available for user",
        );
        throw new ApiError(
          "SERVICE_UNAVAILABLE",
          503,
          "No built-in agents available.",
        );
      }
    }

    const transcriptionService = await resolveTranscriptionService(userId);

    // Fast path: bookkeeping doesn't need MCP / skills / catalog —
    // build a stub runtime and return early.
    if (!classified) {
      const stubAgents: Record<string, BuiltInAgent> = {};
      for (const id of agentIds) {
        stubAgents[id] = new BuiltInAgent({ model: "stub" });
      }
      try {
        return await runWithAgents(request, {
          agents: stubAgents,
          endpoint: "/api/copilotkit/builtin",
          // No runner — bookkeeping skips persistence and replay.
          trimMessages: false,
          entitySource: "builtin",
          transcriptionService,
          diag: { userId },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        requestLog.error(
          { event: "bookkeeping_error", userId, error: message },
          "builtin bookkeeping request failed",
        );
        throw err;
      }
    }

    // Persist the run + user_message BEFORE the expensive build
    // step. Anchoring `started_at` at request-receipt time keeps TTFT
    // honest and makes build-phase failures observable as `failed`
    // rows. See docs/runner-events.md.
    let runId: string | null = null;
    let threadId: string | undefined;
    let dbRunner: PersistedAgentRunner | undefined;
    let preBuildSeq = 0;
    if (classified?.action === "run") {
      const peek = await extractRunInput(request);
      threadId = peek.threadId;
      const run = await recordRunStart({
        entityId: classified.agentId,
        entityKind: "agent",
        entitySource: "builtin",
        mode: "sync",
        task: peek.task,
        threadId,
        initiator: "user",
        ownerId: userId,
        createdBy: userId,
      });
      runId = run.id;
      // Normal chat: write `message` at seq 0.
      // Continuation: write `tool_call_result` events instead. The
      // matching `tool_call_chunk` lives on the PREVIOUS run — this
      // run's INPUT, linked by `toolCallId`. NO `user_message` is
      // emitted (would just duplicate the stale prior prompt).
      // See docs/runner-events.md.
      if (peek.triggeringToolResults.length > 0) {
        for (const tr of peek.triggeringToolResults) {
          await recordEvent(run.id, preBuildSeq, "tool_call_result", tr);
          preBuildSeq += 1;
        }
      } else {
        preBuildSeq = await recordUserMessage(
          run.id,
          0,
          peek.task,
          peek.userMessageId,
        );
      }
      log.info(
        {
          event: "run_started",
          runId: run.id,
          entityId: classified.agentId,
          entityKind: "agent",
          entitySource: "builtin",
          ownerId: userId,
          continuation: peek.triggeringToolResults.length > 0,
        },
        "entity_run started",
      );
    }

    // Idempotent — `finalizeRun` filters on `status = 'running'`.
    const finalizeIfCreated = async (errorMessage: string): Promise<void> => {
      if (runId === null) return;
      try {
        await finalizeRun(runId, "failed", { errorMessage });
      } catch (err) {
        requestLog.error(
          {
            runId,
            err: err instanceof Error ? err.message : String(err),
          },
          "failed to finalize run after build-phase failure",
        );
      }
    };

    // Expensive step: MCP discovery can block tens of seconds.
    // Visible on the timeline because we already wrote the message row.
    const mode = resolveOrchestrationMode(
      request.headers.get(ORCHESTRATION_MODE_HEADER),
    ).id;
    let agents: Record<string, BuiltInAgent>;
    let borrowed: BorrowRecord[];
    let degradations: Map<string, CapabilityDegradation[]>;
    let supervisorRunHolders: Map<string, ParentRunIdHolder>;
    try {
      ({ agents, borrowed, degradations, supervisorRunHolders } =
        await buildBuiltinAgents(agentIds, requestLog, { userId, mode, runId: runId ?? undefined }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await finalizeIfCreated(`agent_build_threw: ${message}`);
      throw err;
    }

    if (Object.keys(agents).length === 0) {
      // Rare race — every visible agent had unresolvable specs.
      releaseBuiltinBorrows(borrowed);
      requestLog.warn(
        { event: "specs_all_null", userId, durationMs: Date.now() - start },
        "all visible agents had unresolvable specs",
      );
      await finalizeIfCreated("specs_all_null");
      throw new ApiError(
        "SERVICE_UNAVAILABLE",
        503,
        "No built-in agents available.",
      );
    }

    // Wire up per-request runner + supervisor holder + degraded rows.
    if (classified?.action === "run") {
      const targetId = classified.agentId;
      const targetAgent = agents[targetId];
      if (!targetAgent) {
        // Build failed for this specific agent — surface as 503.
        const degraded = degradations.get(targetId);
        const reason = degraded?.map((d) => d.message).join("; ") ?? "unknown";
        releaseBuiltinBorrows(borrowed);
        requestLog.error(
          { event: "agent_build_failed", agentId: targetId, reason },
          "target agent unavailable after build; returning 503",
        );
        await finalizeIfCreated(`agent_build_failed: ${reason}`);
        throw new ApiError(
          "SERVICE_UNAVAILABLE",
          503,
          `Agent '${targetId}' is temporarily unavailable: ${reason}`,
        );
      }
      // CONTRACT: runId is set above whenever action === "run".
      const ensuredRunId = runId!;
      // Plumb supervisor's run.id + threadId so delegate sub-runs link
      // back as children AND stay grouped under the same thread.
      const supervisorHolder = supervisorRunHolders.get(targetId);
      if (supervisorHolder) {
        supervisorHolder.current = ensuredRunId;
        supervisorHolder.threadId = threadId;
      }
      // Persist degradations AFTER user_message so the timeline reads
      // user_message → degraded → started → … (build-phase latency
      // visible as the gap).
      const degraded = degradations.get(targetId) ?? [];
      const startSeq = await recordCapabilityDegradations(
        ensuredRunId,
        degraded,
        requestLog,
        preBuildSeq,
      );
      dbRunner = new PersistedAgentRunner({
        runId: ensuredRunId,
        ownerId: userId,
        startSeq,
        log: requestLog,
      });
    } else if (classified?.action === "connect") {
      // /connect: no new run row, but replay events from DB.
      dbRunner = new PersistedAgentRunner({
        ownerId: userId,
        log: requestLog,
      });
    }

    const sealed = await injectServerUserId(request, userId);

    const dispatch = async (): Promise<Response> => {
      try {
        return await runWithAgents(sealed, {
          agents,
          endpoint: "/api/copilotkit/builtin",
          runner: dbRunner,
          // Built-in LLM agents need full history; backends with
          // their own session memory trim instead.
          trimMessages: false,
          entitySource: "builtin",
          transcriptionService,
          diag: {
            agentId: classified?.agentId,
            userId,
          },
        });
      } catch (err) {
        if (runId) {
          const message = err instanceof Error ? err.message : String(err);
          await finalizeRun(runId, "failed", { errorMessage: message });
        }
        throw err;
      }
    };

    try {
      // Skip Langfuse on bookkeeping so user runs aren't drowned out.
      if (!classified) return await dispatch();

      return await withTrace(
        {
          target: "builtin",
          name: `builtin_agent_${classified.action}`,
          userId,
          sessionId: threadId,
          tags: [`agent:${classified.agentId}`, `action:${classified.action}`],
          metadata: { requestId, path: url.pathname, method: request.method },
        },
        async (trace) => {
          const res: Response = await dispatch();
          trace?.update({ output: { status: res.status } });
          return res;
        },
      );
    } finally {
      // CONTRACT: release every borrow exactly once.
      releaseBuiltinBorrows(borrowed);
      // Flush Langfuse before the Node worker recycles.
      await flushLangfuse();
    }
  }

  async start(input: StartRunInput): Promise<ProgrammaticRunResult> {
    if (input.mode === "sync") return this.startSync(input);
    if (input.mode === "async") return this.startAsync(input);
    throw new Error(
      `Runner.start: unsupported mode "${input.mode}" (sync | async only).`,
    );
  }

  /** Pure-introspection target classification.
   *  BORROW LIFECYCLE: the ledger from `buildDispatchAgent` MUST be
   *  released exactly once. Sync releases in `finally`; async releases
   *  from the subscribe error/complete callbacks so background work
   *  keeps the borrow alive until the stream finishes. */
  private classifyDispatchTarget(input: StartRunInput): {
    isBackend: boolean;
    entitySource: "backend" | "builtin";
    kind: EntityKind;
  } {
    const isBackend = input.credentialId !== undefined;
    const entitySource: "backend" | "builtin" = isBackend ? "backend" : "builtin";
    // Built-in entities are always "agent".
    if (isBackend && !input.entityKind) {
      throw new Error(
        "Runner.start: entityKind is required for backend dispatch.",
      );
    }
    const kind: EntityKind = isBackend ? input.entityKind! : "agent";
    return { isBackend, entitySource, kind };
  }

  /** Build inner agent + borrow ledger + degradations. The expensive
   *  step (MCP discovery / model resolve / supervisor catalog) lives
   *  here, after `recordRunStart`, so the build wait is visible on
   *  the timeline. */
  private async buildDispatchAgent(
    input: StartRunInput,
    kind: EntityKind,
  ): Promise<{
    innerAgent: AbstractAgent;
    borrowed: BorrowRecord[];
    degradations: CapabilityDegradation[];
  }> {
    const { agent: innerAgent, borrowed, degradations } =
      await this.buildAgentForProgrammatic(input, kind);
    return { innerAgent, borrowed, degradations };
  }

  /** Synthesised `RunAgentInput`. CONTRACT: bridges read the user
   *  message from `messages` and `user_id` from `forwardedProps`. */
  private buildSyntheticRunInput(
    runId: string,
    input: StartRunInput,
  ): RunAgentInput {
    const prev = input.previousMessages ?? [];
    return {
      threadId: input.threadId ?? randomUUID(),
      runId,
      state: {},
      messages: [
        ...prev.map((m, idx) => ({
          id: String(idx),
          role: m.role as "user" | "assistant" | "system",
          content: m.content,
        })),
        {
          id: String(prev.length),
          role: "user",
          content: input.task,
        },
      ],
      tools: [],
      context: [],
      forwardedProps: { user_id: input.ownerId },
    };
  }

  /** Synchronous in-process dispatch (used by `delegate_to_agent`).
   *  Returns terminal state + joined TEXT_MESSAGE_* deltas.
   *  Stage order mirrors `runBuiltinChatRequest` for TTFT parity:
   *  classify → recordRunStart → build → degradations → run.
   *  See docs/runner-events.md. */
  private async startSync(input: StartRunInput): Promise<ProgrammaticRunResult> {
    const { entitySource, kind } = this.classifyDispatchTarget(input);

    // One threadId reused by recordRunStart and the synthetic input.
    const threadId = input.threadId ?? randomUUID();

    const run = await recordRunStart({
      parentRunId: input.parentRunId,
      threadId,
      scheduleId: input.scheduleId,
      initiator: input.initiator,
      entityId: input.entityId,
      entityKind: kind,
      entitySource,
      credentialId: input.credentialId,
      mode: input.mode,
      task: input.task,
      context: input.context,
      params: input.params,
      ownerId: input.ownerId,
      createdBy: input.createdBy,
      deadline: input.deadline,
    });

    log.info(
      {
        event: "run_started",
        runId: run.id,
        entityId: input.entityId,
        entityKind: kind,
        entitySource,
        parentRunId: input.parentRunId,
        threadId,
        ownerId: input.ownerId,
        initiator: input.initiator,
        mode: "sync_programmatic",
      },
      "entity_run started (programmatic)",
    );

    let innerAgent: AbstractAgent;
    let borrowed: BorrowRecord[];
    let degradations: CapabilityDegradation[];
    try {
      ({ innerAgent, borrowed, degradations } = await this.buildDispatchAgent(
        input,
        kind,
      ));
    } catch (err) {
      // Build failed AFTER recordRunStart — surface as a failed row.
      const message = err instanceof Error ? err.message : String(err);
      try {
        await finalizeRun(run.id, "failed", {
          errorMessage: `agent_build_threw: ${message}`,
        });
      } catch (finErr) {
        log.error(
          {
            runId: run.id,
            err: finErr instanceof Error ? finErr.message : String(finErr),
          },
          "failed to finalize sync run after build failure",
        );
      }
      throw err;
    }

    try {
      // Programmatic dispatch has no user-message event (task lives
      // on `entity_run.input_task`), so degradations start at seq 0.
      const startSeq = await recordCapabilityDegradations(
        run.id,
        degradations,
        log,
        0,
      );
      const persistedAgent = new PersistingAgent({
        inner: innerAgent,
        runId: run.id,
        startSeq,
      });
      const runAgentInput = this.buildSyntheticRunInput(run.id, { ...input, threadId });

      const syncTimeoutMs = getConfigMs("runner.sync_timeout", 300);

      // Hold the subscription so the timeout path can cancel immediately.
      let subscription: { unsubscribe(): void } | undefined;

      const agentPromise = new Promise<ProgrammaticRunResult>((resolve) => {
        let summary = "";
        let errorMessage: string | undefined;

        subscription = persistedAgent.run(runAgentInput).subscribe({
          next: (rawEvent: BaseEvent) => {
            const event = rawEvent as AgUiEvent;
            // Built-in emits TEXT_MESSAGE_CHUNK; bridges emit TEXT_MESSAGE_CONTENT.
            if (
              event.type === EventType.TEXT_MESSAGE_CONTENT
              || event.type === EventType.TEXT_MESSAGE_CHUNK
            ) {
              if (typeof event.delta === "string") summary += event.delta;
            } else if (event.type === EventType.RUN_ERROR) {
              errorMessage = event.message;
            }
          },
          error: (err: unknown) => {
            // PersistingAgent already finalised the row.
            const message = err instanceof Error ? err.message : String(err);
            resolve({
              runId: run.id,
              status: "failed",
              summary,
              errorMessage: errorMessage ?? message,
            });
          },
          complete: () => {
            resolve({
              runId: run.id,
              status: errorMessage ? "failed" : "succeeded",
              summary,
              ...(errorMessage ? { errorMessage } : {}),
            });
          },
        });
      });

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutMsg = `Sync run timed out after ${syncTimeoutMs / 1000}s`;
      const timeoutPromise = new Promise<ProgrammaticRunResult>((resolve) => {
        timer = setTimeout(() => {
          // Cancel the stream so MCP connections / memory release immediately.
          subscription?.unsubscribe();
          log.warn({ runId: run.id, timeoutMs: syncTimeoutMs }, timeoutMsg);
          finalizeRun(run.id, "failed", { errorMessage: timeoutMsg }).catch(() => {});
          resolve({
            runId: run.id,
            status: "failed",
            summary: "",
            errorMessage: timeoutMsg,
          });
        }, syncTimeoutMs);
      });

      try {
        return await Promise.race([agentPromise, timeoutPromise]);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      releaseBuiltinBorrows(borrowed);
    }
  }

  /**
   * Asynchronous in-process dispatch. Returns immediately with the
   * runId; the agent streams in the background; the user is notified
   * via EventBus + `notification` row on terminal events.
   */
  private async startAsync(input: StartRunInput): Promise<ProgrammaticRunResult> {
    const { entitySource, kind } = this.classifyDispatchTarget(input);

    const threadId = input.threadId ?? randomUUID();

    const run = await recordRunStart({
      parentRunId: input.parentRunId,
      threadId,
      scheduleId: input.scheduleId,
      initiator: input.initiator,
      entityId: input.entityId,
      entityKind: kind,
      entitySource,
      credentialId: input.credentialId,
      mode: input.mode,
      task: input.task,
      context: input.context,
      params: input.params,
      ownerId: input.ownerId,
      createdBy: input.createdBy,
      deadline: input.deadline,
    });

    log.info(
      {
        event: "run_started",
        runId: run.id,
        entityId: input.entityId,
        entityKind: kind,
        entitySource,
        parentRunId: input.parentRunId,
        threadId,
        ownerId: input.ownerId,
        initiator: input.initiator,
        mode: "async_programmatic",
      },
      "entity_run started (programmatic, async)",
    );

    let entityName = input.entityId;
    if (entitySource === "builtin" && kind === "agent") {
      try {
        const [agent] = await db
          .select({ name: BuiltinAgentTable.name })
          .from(BuiltinAgentTable)
          .where(eq(BuiltinAgentTable.id, input.entityId))
          .limit(1);
        if (agent) {
          entityName = agent.name;
        }
      } catch (err) {
        log.warn({ err }, "failed to fetch builtin agent name for run_started event");
      }
    }

    publish(input.ownerId, {
      kind: "run_started",
      runId: run.id,
      ownerId: input.ownerId,
      entityId: entityName,
      entityKind: kind,
      startedAt: run.startedAt ?? new Date(),
    });

    let innerAgent: AbstractAgent;
    let borrowed: BorrowRecord[];
    let degradations: CapabilityDegradation[];
    try {
      ({ innerAgent, borrowed, degradations } = await this.buildDispatchAgent(
        input,
        kind,
      ));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await finalizeRun(run.id, "failed", {
          errorMessage: `agent_build_threw: ${message}`,
        });
      } catch (finErr) {
        log.error(
          {
            runId: run.id,
            err: finErr instanceof Error ? finErr.message : String(finErr),
          },
          "failed to finalize async run after build failure",
        );
      }
      throw err;
    }

    // Pre-subscribe failures release-and-rethrow; after subscribe the
    // error/complete callbacks own release.
    let released = false;
    const releaseBorrows = (): void => {
      if (released) return;
      released = true;
      releaseBuiltinBorrows(borrowed);
    };

    try {
      // No user_message event for programmatic — task lives on `input_task`.
      const startSeq = await recordCapabilityDegradations(
        run.id,
        degradations,
        log,
        0,
      );
      const persistedAgent = new PersistingAgent({
        inner: innerAgent,
        runId: run.id,
        startSeq,
      });
      const runAgentInput = this.buildSyntheticRunInput(run.id, { ...input, threadId });

      // PersistingAgent persists + finalises; we accumulate preview text.
      let summary = "";
      let errorMessage: string | undefined;
      const ownerId = input.ownerId;
      const sourceLabel = input.sourceLabel ?? null;
      const task = input.task;

      const asyncTimeoutMs = getConfigMs("runner.async_timeout", 1800);
      let settled = false;

      const subscription = persistedAgent.run(runAgentInput).subscribe({
        next: (rawEvent: BaseEvent) => {
          const event = rawEvent as AgUiEvent;
          if (
            event.type === EventType.TEXT_MESSAGE_CONTENT
            || event.type === EventType.TEXT_MESSAGE_CHUNK
          ) {
            if (typeof event.delta === "string") summary += event.delta;
          } else if (event.type === EventType.RUN_ERROR) {
            errorMessage = event.message;
          }
        },
        error: (err: unknown) => {
          settled = true;
          clearTimeout(asyncTimer);
          try {
            const message = err instanceof Error ? err.message : String(err);
            const finalMessage = errorMessage ?? message;
            publish(ownerId, {
              kind: "run_finalized",
              runId: run.id,
              ownerId,
              status: "failed",
              preview: previewBody(finalMessage) ?? undefined,
            });
            void recordRunNotification({
              ownerId,
              runId: run.id,
              kind: "run_failed",
              title: "Async task failed",
              body: finalMessage,
              sourceLabel,
              task,
              initiator: input.initiator,
            });
          } finally {
            releaseBorrows();
          }
        },
        complete: () => {
          settled = true;
          clearTimeout(asyncTimer);
          try {
            const status: "succeeded" | "failed" = errorMessage
              ? "failed"
              : "succeeded";
            publish(ownerId, {
              kind: "run_finalized",
              runId: run.id,
              ownerId,
              status,
              preview:
                previewBody(status === "failed" ? errorMessage : summary)
                ?? undefined,
            });
            void recordRunNotification({
              ownerId,
              runId: run.id,
              kind: status === "failed" ? "run_failed" : "run_completed",
              title:
                status === "failed"
                  ? "Async task failed"
                  : "Async task completed",
              body: status === "failed" ? errorMessage : summary,
              sourceLabel,
              task,
              initiator: input.initiator,
            });
          } finally {
            releaseBorrows();
          }
        },
      });

      // Guard against zombie runs: cancel and finalize if the run
      // exceeds the configured async timeout (default 30 min).
      const asyncTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const timeoutMsg =
          `Async run timed out after ${asyncTimeoutMs / 1000}s`;
        subscription.unsubscribe();
        log.warn({ runId: run.id, timeoutMs: asyncTimeoutMs }, timeoutMsg);
        finalizeRun(run.id, "failed", { errorMessage: timeoutMsg })
          .catch(() => {});
        publish(ownerId, {
          kind: "run_finalized",
          runId: run.id,
          ownerId,
          status: "failed",
          preview: timeoutMsg,
        });
        void recordRunNotification({
          ownerId,
          runId: run.id,
          kind: "run_failed",
          title: "Async task timed out",
          body: timeoutMsg,
          sourceLabel,
          task,
          initiator: input.initiator,
        });
        releaseBorrows();
      }, asyncTimeoutMs);

      return {
        runId: run.id,
        status: "running",
        summary: "",
      };
    } catch (err) {
      releaseBorrows();
      throw err;
    }
  }

  /** Build the in-process agent for a programmatic run. Backend goes
   *  through the provider chat handler; built-in through
   *  `buildBuiltinAgents`. Returns agent + borrow ledger + per-agent
   *  degradations; caller owns release + persists degradations after
   *  recordRunStart. CONTRACT: throws on resolution failure. */
  private async buildAgentForProgrammatic(
    input: StartRunInput,
    kind: EntityKind,
  ): Promise<{
    agent: AbstractAgent;
    borrowed: BorrowRecord[];
    degradations: CapabilityDegradation[];
  }> {
    if (input.credentialId) {
      const credentialId = input.credentialId;
      const provider = await this.providerForCredential(credentialId);
      const handler = getChatHandler(provider);
      if (!handler) {
        throw new Error(
          `Runner.start: no chat handler for provider="${provider ?? "(none)"}".`,
        );
      }
      const ctx: ChatContext = {
        credentialId,
        agentId: input.entityId,
        agentKind: kind,
        userId: input.ownerId,
        endpoint: "/api/copilotkit",
      };
      const built = await handler.buildAgent(ctx);
      if (built instanceof Response) {
        const body = await built.text().catch(() => "");
        throw new Error(
          `Runner.start: ${input.entityId} build failed: ${built.status} ${body.slice(0, 200)}`,
        );
      }
      // Backend dispatches don't take borrows or carry degradations.
      return { agent: built, borrowed: [], degradations: [] };
    }

    const programmaticLog = childLogger({
      component: "runner",
      programmatic: true,
    });
    const { agents, borrowed, degradations } = await buildBuiltinAgents(
      [input.entityId],
      programmaticLog,
      // Pass ownerId so ambient tools (get_current_datetime) resolve
      // the run owner's profile timezone in headless async / scheduled
      // runs — otherwise userId is undefined here and the tool falls
      // back to the server timezone. Safe re: supervisor side-effects:
      // catalog excludes system-role agents, so the supervisor branch
      // in buildBuiltinAgents never fires on this path.
      { userId: input.ownerId, context: input.context },
    );
    const builtinAgent = agents[input.entityId];
    if (!builtinAgent) {
      releaseBuiltinBorrows(borrowed);
      // Use the per-agent degradation reason when available — it is
      // more specific than the generic fallback. For a deleted agent
      // this carries "Agent spec unavailable (disabled, deleted, or
      // invalid)." which surfaces in the workflow AGENT_EXECUTION_FAILED
      // message and helps the user distinguish deletion from a missing
      // credential or model misconfiguration.
      const agentDegradations = degradations.get(input.entityId) ?? [];
      const reason =
        agentDegradations.length > 0
          ? agentDegradations.map((d) => d.message).join("; ")
          : "disabled, missing credential, or unsupported model";
      throw new Error(
        `Runner.start: built-in agent ${input.entityId} could not be resolved — ${reason}`,
      );
    }
    return {
      agent: builtinAgent,
      borrowed,
      degradations: degradations.get(input.entityId) ?? [],
    };
  }
}

export const runnerImpl: Runner = new RunnerImpl();
