/**
 * Runner — execution kernel implementation.
 *
 * @see docs/orchestrator.md#11-implementation-details-and-quirks
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
import { previewBody, recordRunNotification } from "./notifications";
import type {
  ProgrammaticRunResult,
  Runner,
  RunBuiltinChatRequestArgs,
  StartRunInput,
} from "./types";

const log = childLogger({ component: "runner" });

/** True iff the request is a real run dispatch (not CopilotKit's
 *  `/info` / `/threads/*` bookkeeping). Bookkeeping calls skip the
 *  `entity_run` lifecycle. */
function isRunRequest(request: Request): boolean {
  return (
    request.method === "POST" &&
    /\/agent\/[^/]+\/run\b/.test(new URL(request.url).pathname)
  );
}

/** True iff the request targets the SSE `/connect` endpoint. Connect
 *  is a read-only resume — no `entity_run` row is created — but we
 *  still inject `PersistedAgentRunner` so `.connect()` can replay
 *  events from `entity_run_event` instead of returning an empty
 *  in-memory stream after a server restart. */
function isConnectRequest(request: Request): boolean {
  return /\/agent\/[^/]+\/connect\b/.test(new URL(request.url).pathname);
}

// `extractRunInput` lives in its own module so the body-parsing
// rules can be unit-tested in isolation. See
// `src/lib/runner/extract-run-input.ts`.

/** Persist the user's prompt as a `message` event row on the run
 *  timeline. The row's `messageId` matches the client's local
 *  message id so `/connect` history replay emits a TEXT_MESSAGE_*
 *  triplet the client deduplicates against its own state — avoiding
 *  the duplicate-user-message render described on
 *  `RunInputPeek.userMessageId`.
 *
 *  Returns the next available `seq` after the write so callers can
 *  set `PersistedAgentRunner.startSeq` correctly. The write is
 *  skipped (and the input seq is returned unchanged) when the
 *  caller doesn't have a user prompt at hand (programmatic /
 *  scheduled runs, parse failures). */
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
    // CONTRACT: backend-only entry-point. Built-in chat goes through
    // `runBuiltinChatRequest`.
    if (!input.credentialId) {
      return NextResponse.json(
        { error: "Runner.runChatRequest: credentialId required (backend chat only)." },
        { status: 400 },
      );
    }

    const credentialId = input.credentialId;

    // SECURITY: missing kind on backend dispatch is a programmer error — fail fast.
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
      // CONTRACT: handler returned credential / config error; do
      // NOT create a run row.
      return built;
    }
    const innerAgent: AbstractAgent = built;

    // Bookkeeping paths (/info, /threads/*) skip the run lifecycle
    // entirely — no entity_run row.
    //
    // /connect IS bookkeeping (no new row) but we still attach a
    // `PersistedAgentRunner` (without runId) so .connect() replays
    // historic events from `entity_run_event` instead of returning
    // an empty stream after server restart.
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

    // CONTRACT: body threadId is the AG-UI source of truth for programmatic or HTTP callers.
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

    // Continuation vs normal chat — see the same dichotomy in
    // `runBuiltinChatRequest` and `docs/runner-events.md`
    // §"Continuation runs". Backend agents typically don't use
    // frontend tools (they have their own session memory) so this
    // branch is rarely entered, but kept symmetric so a backend
    // adapter that DID use HITL would behave consistently.
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

    // Inject PersistedAgentRunner via ctx.runner — the runner wraps the
    // inner agent with PersistingAgent inside its own .run() AND owns
    // .connect() history replay from entity_run_event.
    ctx.runner = new PersistedAgentRunner({
      runId: run.id,
      ownerId: input.ownerId,
      startSeq,
      log,
    });

    // Overwrite `forwardedProps.user_id` with the session-derived
    // ownerId before handing the request to CopilotKit. Bridges
    // (agno / Mastra / Dify) trust this field unconditionally.
    // @see ./inject-user-id.ts
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

  /** QUIRK: lazy import — `credential-lookup` is server-only and we
   *  don't want it pulled into the runner-types graph inadvertently. */
  private async providerForCredential(credentialId: string): Promise<string | null> {
    const { getCredentialConfigById } = await import("@/lib/credentials/lookup");
    const cfg = await getCredentialConfigById(credentialId);
    return cfg?.provider ?? null;
  }

  // Built-in chat request

  async runBuiltinChatRequest(
    request: Request,
    args: RunBuiltinChatRequestArgs,
  ): Promise<Response> {
    const { userId, requestId, log: requestLog } = args;
    const url: URL = new URL(request.url);
    const start: number = Date.now();
    const classified = classifyBuiltinPath(url.pathname);

    // 1. Authorisation + agent set selection
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

    // Fast path: bookkeeping requests (/info, /threads/*) don't need
    // the full agent build (MCP borrow, skill resolve, supervisor
    // catalog). Build a lightweight stub runtime and return early.
    if (!classified) {
      const stubAgents: Record<string, BuiltInAgent> = {};
      for (const id of agentIds) {
        stubAgents[id] = new BuiltInAgent({ model: "stub" });
      }
      try {
        return await runWithAgents(request, {
          agents: stubAgents,
          endpoint: "/api/copilotkit/builtin",
          // No runner — bookkeeping (/info, /threads/*) skips
          // persistence and history replay.
          trimMessages: false,
          entitySource: "builtin",
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

    // 2. Persist the run + user-message FIRST, BEFORE any expensive
    //    build step (MCP discovery, model resolution, supervisor
    //    catalog composition). Anchoring `entity_run.started_at` at
    //    HTTP-request-receipt time — not at build completion — means:
    //
    //    a. TTFT (= MIN(event.ts) - started_at) reflects the user's
    //       real wait, including any blocking MCP discovery latency
    //       (a single unreachable server can add 10-30s before the
    //       LLM emits its first token).
    //    b. Admin can see the gap on the timeline: `user_message`
    //       row sits at T0, `degraded`/`started` rows land at T0+Nsec
    //       — N is the build phase made visible.
    //    c. Build-phase failures (specs all null / target missing /
    //       buildBuiltinAgents throws) leave a `failed` row that
    //       surfaces in `/admin/thread`, instead of vanishing into
    //       the request log.
    //
    //    @see docs/runner-events.md §"TTFT and event timestamps"
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
      // Two mutually-exclusive entry shapes:
      //
      // (a) Normal chat turn — `triggeringToolResults` is empty.
      //     Write a `message` event with the user's prompt at seq 0
      //     so history replay carries the client-generated message
      //     id (deduplicates the post-`/connect` re-render).
      //
      // (b) Continuation turn — the LLM was paused on a frontend /
      //     HITL tool call and the user just supplied result(s).
      //     Write the tool result(s) as `tool_call_result` events
      //     instead. The pairing `tool_call_chunk` lives on the
      //     PREVIOUS entity_run (closed when the LLM emitted it);
      //     this run is the LLM's continuation, so the result is
      //     its INPUT, not the prior run's output. Linking is by
      //     `toolCallId`. NO `user_message` event is written —
      //     repeating the stale prior prompt would confuse admins
      //     scanning the timeline.
      //
      // @see docs/runner-events.md §"Continuation runs"
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

    // Helper: ensure a record-failed for any run we already created
    // before re-throwing a build-time error. Idempotent — the
    // `finalizeRun` UPDATE filters on `status = 'running'` so a
    // double-call is a no-op.
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

    // 3. Build agents (resolves specs, borrows MCP, composes prompts).
    //    Forwards `mode` so supervisor prompts pick up the per-mode
    //    directive (auto / tool-call). Unknown values fall back to
    //    the default in `resolveOrchestrationMode`.
    //
    //    THIS IS THE EXPENSIVE STEP. MCP discovery happens here and
    //    can block the request for tens of seconds when a server is
    //    unreachable. The wait is now visible on the run timeline
    //    because step 2 already wrote the `message` row.
    const mode = resolveOrchestrationMode(
      request.headers.get(ORCHESTRATION_MODE_HEADER),
    ).id;
    let agents: Record<string, BuiltInAgent>;
    let borrowed: BorrowRecord[];
    let degradations: Map<string, CapabilityDegradation[]>;
    let supervisorRunHolders: Map<string, ParentRunIdHolder>;
    try {
      ({ agents, borrowed, degradations, supervisorRunHolders } =
        await buildBuiltinAgents(agentIds, requestLog, { userId, mode }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await finalizeIfCreated(`agent_build_threw: ${message}`);
      throw err;
    }

    if (Object.keys(agents).length === 0) {
      // QUIRK: rare race — every visible agent had unresolvable specs. Bail out.
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

    // 4. Wire up per-request `PersistedAgentRunner` + supervisor
    //    holder + degraded rows. The run row already exists; we're
    //    only attaching the runtime view of it.
    if (classified?.action === "run") {
      const targetId = classified.agentId;
      const targetAgent = agents[targetId];
      if (!targetAgent) {
        // Agent build failed during buildBuiltinAgents (spec missing,
        // model resolution error, etc.). Surface explicitly as 503 so
        // the client gets a clear signal instead of a cryptic 500.
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
      // CONTRACT: runId is set above whenever classified.action === "run".
      const ensuredRunId = runId!;
      // QUIRK: Plumb supervisor's run.id AND threadId into the
      // parent-run holder so `delegate_to_agent` / `delegate_async`
      // sub-runs link back as children AND stay grouped under the
      // same admin thread page. @see ParentRunIdHolder.threadId.
      const supervisorHolder = supervisorRunHolders.get(targetId);
      if (supervisorHolder) {
        supervisorHolder.current = ensuredRunId;
        supervisorHolder.threadId = threadId;
      }
      // Persist build-time degradations AFTER user_message (seq 0)
      // so the admin timeline reads
      //   user_message → degraded → started → ...
      // matching the natural "user asked → system noticed these
      // problems → agent began working" narrative. The `ts` on
      // each degraded row now reflects post-build time (T0+Nsec),
      // making MCP discovery latency visible as the gap between
      // user_message and degraded.
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
      // /connect resume: no new entity_run row, but we still want
      // history replay backed by `entity_run_event` instead of the
      // empty in-process store after a server restart.
      dbRunner = new PersistedAgentRunner({
        ownerId: userId,
        log: requestLog,
      });
    }

    // 5. Overwrite `forwardedProps.user_id` with session userId before
    // CopilotKit dispatches into the agent's run(). Built-in agents
    // don't currently consume forwardedProps.user_id directly (they
    // use the agent spec / supervisor catalog for identity), but any
    // future tool that reads it expects the server-trusted value.
    // @see ./inject-user-id.ts
    const sealed = await injectServerUserId(request, userId);

    const dispatch = async (): Promise<Response> => {
      try {
        return await runWithAgents(sealed, {
          agents,
          endpoint: "/api/copilotkit/builtin",
          runner: dbRunner,
          // Built-in LLM agents need full history; only external
          // backends (which own their own session memory) trim.
          trimMessages: false,
          entitySource: "builtin",
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
      // QUIRK: Bookkeeping endpoints skip Langfuse to avoid drowning out user messages.
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

      // QUIRK: Explicit flush guarantees in-flight Langfuse events ship before recycle.
      await flushLangfuse();
    }
  }

  // Programmatic start

  async start(input: StartRunInput): Promise<ProgrammaticRunResult> {
    if (input.mode === "sync") return this.startSync(input);
    if (input.mode === "async") return this.startAsync(input);
    throw new Error(
      `Runner.start: unsupported mode "${input.mode}" (sync | async only).`,
    );
  }

  /** Cheap target classification — pure introspection of `input`,
   *  no DB or network. Split out from `buildDispatchAgent` so
   *  `start{Sync,Async}` can `recordRunStart` BEFORE blocking on
   *  agent build (MCP discovery can add tens of seconds).
   *
   *  BORROW LIFECYCLE (returned from `buildDispatchAgent`): the
   *  ledger is empty for backend dispatches (provider chat handlers
   *  don't take MCP borrows) and the full per-call list for built-in
   *  dispatches. The caller MUST pass it to `releaseBuiltinBorrows`
   *  exactly once — sync runs in `finally`, async runs from the
   *  subscribe error/complete callbacks (so background work keeps
   *  the borrow alive until the agent stream actually finishes). */
  private classifyDispatchTarget(input: StartRunInput): {
    isBackend: boolean;
    entitySource: "backend" | "builtin";
    kind: EntityKind;
  } {
    const isBackend = input.credentialId !== undefined;
    const entitySource: "backend" | "builtin" = isBackend ? "backend" : "builtin";
    // CONTRACT: built-in entities are always "agent".
    if (isBackend && !input.entityKind) {
      throw new Error(
        "Runner.start: entityKind is required for backend dispatch.",
      );
    }
    const kind: EntityKind = isBackend ? input.entityKind! : "agent";
    return { isBackend, entitySource, kind };
  }

  /** Build the inner agent + borrow ledger + degradations. The
   *  expensive step (MCP discovery, model resolution, supervisor
   *  catalog composition) lives here so that `start{Sync,Async}`
   *  can record the run row first and surface the build wait on
   *  the admin timeline as the gap between `message` (T0) and
   *  the subsequent `degraded` / `started` rows. */
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

  /** Synthesised `RunAgentInput` for `.run()`. CONTRACT: every
   *  bridge reads the user message from `messages` and `user_id`
   *  from `forwardedProps`. */
  private buildSyntheticRunInput(
    runId: string,
    input: StartRunInput,
  ): RunAgentInput {
    return {
      threadId: input.threadId ?? randomUUID(),
      runId,
      state: {},
      messages: [
        {
          id: randomUUID(),
          role: "user",
          content: input.task,
        },
      ],
      tools: [],
      context: [],
      forwardedProps: { user_id: input.ownerId },
    };
  }

  /** Synchronous in-process dispatch. CONTRACT: caller awaits the
   *  terminal state; final summary is the joined `TEXT_MESSAGE_*`
   *  deltas. Used by the supervisor's `delegate_to_agent` tool.
   *
   *  STAGE ORDER (matches `runBuiltinChatRequest` for TTFT parity):
   *    1. classify (cheap)
   *    2. recordRunStart (started_at = NOW, BEFORE build)
   *    3. buildDispatchAgent (MCP discovery, may block) — finalize
   *       on error
   *    4. record degradations (ts reflects post-build time)
   *    5. PersistingAgent.run → subscribe loop
   *
   *  @see docs/runner-events.md §"TTFT and event timestamps"
   */
  private async startSync(input: StartRunInput): Promise<ProgrammaticRunResult> {
    const { entitySource, kind } = this.classifyDispatchTarget(input);

    // Unify threadId: generate once, reuse in both recordRunStart and buildSyntheticRunInput.
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
      // Build failed AFTER recordRunStart — surface as a failed run
      // row so admins can see it on `/admin/thread`.
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

    // Single try/finally spans subscribe-resolved → borrow release.
    try {
      // Programmatic dispatch has no user-message event (the task
      // lives in `entity_run.input_task`, not in the event stream),
      // so degradations start at seq 0.
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

      // Hold the subscription so the timeout path can cancel the
      // agent stream and release MCP connections / memory immediately.
      let subscription: { unsubscribe(): void } | undefined;

      const agentPromise = new Promise<ProgrammaticRunResult>((resolve) => {
        let summary = "";
        let errorMessage: string | undefined;

        subscription = persistedAgent.run(runAgentInput).subscribe({
          next: (rawEvent: BaseEvent) => {
            // BOUNDARY CAST — narrow discriminant switch to AgUiEvent.
            const event = rawEvent as AgUiEvent;
            // CopilotKit built-in emits TEXT_MESSAGE_CHUNK; bridges emit TEXT_MESSAGE_CONTENT.
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
            // CONTRACT: PersistingAgent already finalised the row.
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
          // Cancel the agent stream to release MCP connections and memory.
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
      // CONTRACT: release every MCP borrow exactly once.
      releaseBuiltinBorrows(borrowed);
    }
  }

  /**
   * Asynchronous in-process dispatch. CONTRACT: returns immediately
   * with the runId; the agent stream flows in the background and
   * the user is notified via EventBus + `notification` row on
   * terminal events.
   *
   * @see docs/orchestrator.md#async--recovery
   */
  private async startAsync(input: StartRunInput): Promise<ProgrammaticRunResult> {
    const { entitySource, kind } = this.classifyDispatchTarget(input);

    // Unify threadId: generate once, reuse in both recordRunStart and buildSyntheticRunInput.
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

    let innerAgent: AbstractAgent;
    let borrowed: BorrowRecord[];
    let degradations: CapabilityDegradation[];
    try {
      ({ innerAgent, borrowed, degradations } = await this.buildDispatchAgent(
        input,
        kind,
      ));
    } catch (err) {
      // Build failed AFTER recordRunStart — surface as a failed run
      // row so admins can see it on `/admin/thread`.
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

    // Borrow lifecycle: release-then-rethrow if we fail before subscribe.
    let released = false;
    const releaseBorrows = (): void => {
      if (released) return;
      released = true;
      releaseBuiltinBorrows(borrowed);
    };

    try {
      // Programmatic dispatch has no user-message event (the task
      // lives in `entity_run.input_task`, not in the event stream),
      // so degradations start at seq 0.
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

      // PersistingAgent already persists events and finalizes the row. We accumulate preview here.
      let summary = "";
      let errorMessage: string | undefined;
      const ownerId = input.ownerId;
      const sourceLabel = input.sourceLabel ?? null;
      const task = input.task;

      persistedAgent.run(runAgentInput).subscribe({
        next: (rawEvent: BaseEvent) => {
          // Boundary cast (see sync path above for rationale).
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
            });
          } finally {
            releaseBorrows();
          }
        },
        complete: () => {
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
            });
          } finally {
            releaseBorrows();
          }
        },
      });

      return {
        runId: run.id,
        status: "running",
        summary: "",
      };
    } catch (err) {
      // Pre-subscribe failure. Release orphaned borrows and re-throw.
      releaseBorrows();
      throw err;
    }
  }

  /** Build the in-process agent for a programmatic run. Reuses the
   *  provider chat handler for backend, or `buildBuiltinAgents` for
   *  a single built-in.
   *
   *  Returns the agent paired with the borrow ledger (empty for
   *  backend, the full per-call list for built-in) and any build-
   *  time capability degradations for the targeted agent (also
   *  empty for backend). The caller owns release + persists
   *  degradations after recordRunStart.
   *
   *  CONTRACT: throws on resolution failure (no HTTP envelope to
   *  surface 4xx / 5xx through). */
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
      // Backend dispatches don't take MCP borrows or have degradations.
      return { agent: built, borrowed: [], degradations: [] };
    }

    const programmaticLog = childLogger({
      component: "runner",
      programmatic: true,
    });
    const { agents, borrowed, degradations } = await buildBuiltinAgents(
      [input.entityId],
      programmaticLog,
    );
    const builtinAgent = agents[input.entityId];
    if (!builtinAgent) {
      // Spec failed to resolve. Release immediately.
      releaseBuiltinBorrows(borrowed);
      throw new Error(
        `Runner.start: built-in agent ${input.entityId} could not be resolved (disabled, missing credential, or unsupported model).`,
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
