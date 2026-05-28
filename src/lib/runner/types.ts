/**
 * Runner — execution kernel types.
 */

import "server-only";

import type { EntityRunEventType, EntityRunInitiator, EntityRunMode, EntityRunStatus } from "@/lib/db/schema";
import type { EntityKind } from "@/lib/backends/types";

/**
 * Common shape across all run-start entry points.
 *
 * @see docs/orchestrator.md#11-implementation-details-and-quirks
 */
export interface StartRunInput {
  /**
   * Entity id within the namespace defined by `credentialId`.
   * @see docs/orchestrator.md#11-implementation-details-and-quirks
   */
  entityId: string;
  /** Backend credential; absent → built-in dispatch. */
  credentialId?: string;
  /**
   * CONTRACT: REQUIRED for backend dispatch; ignored for built-in.
   * Type stays optional because TS can't model "required iff credentialId is present".
   */
  entityKind?: EntityKind;

  /** Canonical natural-language prompt. */
  task: string;
  /** Structured side-channel data (built-in / workflow runs). */
  context?: Record<string, unknown>;
  params?: Record<string, unknown>;

  /** Run lifecycle. P0 only implements `"sync"`. */
  mode: EntityRunMode;

  /** Optional run-forest linkage. */
  parentRunId?: string;
  /** CopilotKit thread id this run belongs to (chat path). */
  threadId?: string;
  /**
   * Schedule that triggered this run. Set ONLY when `initiator =
   * "schedule"` — every other initiator leaves this undefined.
   * Persisted into `entity_run.schedule_id` so the ScheduleEditor's
   * RecentRuns panel can paginate by it. Optional so non-scheduler
   * call sites stay untouched.
   */
  scheduleId?: string;

  initiator: EntityRunInitiator;
  ownerId: string;
  createdBy: string;
  deadline?: Date;

  /** Human-readable source label for notifications. Denormalised so it
   *  survives renames/deletions. */
  sourceLabel?: string;
}

/** Returned synchronously from `Runner.start()`. */
export interface RunHandle {
  runId: string;
  status: EntityRunStatus;
}

/**
 * Nango-neutral event shape, distinct from AG-UI transport.
 * Persisted into `entity_run_event.payload`.
 * @see docs/runner-events.md#stage-2--coalescing
 */
export type RunEvent =
  | { type: "started";          runId: string; ts: number; payload: { mode: EntityRunMode } }
  | { type: "message";          runId: string; ts: number; payload: { messageId: string; role: string; text: string } }
  | { type: "reasoning";        runId: string; ts: number; payload: { messageId: string; text: string } }
  | { type: "tool_call_chunk";  runId: string; ts: number; payload: { toolCallId: string; toolName: string; args: string } }
  | { type: "tool_call_result"; runId: string; ts: number; payload: { toolCallId: string; content: string } }
  | { type: "finished";         runId: string; ts: number; payload: { summary?: string; output?: unknown } }
  | { type: "error";            runId: string; ts: number; payload: { message: string; errorType?: string } };

export type { EntityRunEventType, EntityRunStatus, EntityRunMode, EntityRunInitiator };

/** Per-request context for built-in chat dispatch. */
export interface RunBuiltinChatRequestArgs {
  userId: string;
  requestId: string;
  log: import("pino").Logger;
}

/**
 * Result of `Runner.start(mode: "sync")`. `summary` is the accumulated
 * text reply fed back to the LLM by `delegate_to_agent`.
 */
export interface ProgrammaticRunResult {
  runId: string;
  status: EntityRunStatus;
  summary: string;
  errorMessage?: string;
}

/** Runner kernel interface. Concrete impl in `runner.ts`. */
export interface Runner {
  /** Backend chat over AG-UI. CONTRACT: persists `entity_run` + `entity_run_event`s. */
  runChatRequest(
    request: Request,
    input: StartRunInput,
  ): Promise<Response>;

  /** Built-in chat. Runner owns auth, MCP/skills, Langfuse, persistence. */
  runBuiltinChatRequest(
    request: Request,
    args: RunBuiltinChatRequestArgs,
  ): Promise<Response>;

  /**
   * Programmatic sync start (used by `delegate_to_agent`). CONTRACT:
   * resolves descriptor, builds agent, persists run, drives `agent.run()`,
   * returns terminal state + text. P0 only ships `mode: "sync"`.
   */
  start(input: StartRunInput): Promise<ProgrammaticRunResult>;
}
