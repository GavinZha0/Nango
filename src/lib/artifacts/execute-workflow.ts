/**
 * Production `executeWorkflow` implementation. Wires
 * `inProcessWorkflowEngine` to the user-scoped tool catalog and
 * surfaces the result as a `DataResolution`.
 *
 * Refresh-path (`forceFresh: true`) records to entity_run and
 * dispatches real agent sub-runs; GET-path skips both. `WorkflowError`
 * from the engine returns `null` (bundle ships without `data`);
 * other throws propagate.
 *
 * See docs/workflow.md.
 */

import "server-only";

import { randomUUID } from "node:crypto";

import { buildUserToolCatalog } from "@/lib/builtin-tools/build-user-catalog";
import type { ToolDefinition } from "@/lib/copilot/index.server";
import { logger as observabilityLogger } from "@/lib/observability/logger";
import { WorkflowError } from "@/lib/workflows/error";
import { inProcessWorkflowEngine } from "@/lib/workflows/engine/in-process";
import type {
  AgentRunRequest,
  AgentRunResult,
  CodeRunRequest,
  CodeRunResult,
  ToolHandle,
  WorkflowEngineDependencies,
  WorkflowEngineEvent,
} from "@/lib/workflows/engine";
import { runner } from "@/lib/runner";
import { getActiveAdapter } from "@/lib/sandbox/registry.server";
import type { CanonicalWorkflowSpec } from "@/lib/workflows/spec/schema";

import type { DataResolution } from "./bundle";
import { startRecording } from "./workflow-run-recorder";

// ─── Public surface ────────────────────────────────────────────────────

export interface ExecuteWorkflowArgs {
  workflowId: string;
  spec: CanonicalWorkflowSpec;
  outputField: string;
  ownerId: string;
  forceFresh?: boolean;
  /** Human-readable workflow name surfaced into `entity_run.input_task`
   *  ("Refresh workflow: <name>"). Falls back to a generic label when
   *  omitted. Only consumed when `forceFresh: true` triggers recording. */
  workflowName?: string;
}

/**
 * Production executor. Returns `null` on `WorkflowError` (bundle
 * ships without data); throws on unexpected errors.
 */
export async function executeWorkflow(
  args: ExecuteWorkflowArgs,
): Promise<DataResolution | null> {
  const log = observabilityLogger.child({
    event: "workflow_resolve",
    workflowId: args.workflowId,
    ownerId: args.ownerId,
  });

  const catalog = await buildUserToolCatalog(args.ownerId);

  // Persist a forensic entity_run + event timeline only on the
  // refresh path. `recorder` is null when forceFresh wasn't set or
  // when startRecording itself failed — both paths fall through to
  // noopEmitEvent and a request-local runId.
  const recorder = args.forceFresh === true
    ? await startRecording({
        workflowId: args.workflowId,
        ownerId: args.ownerId,
        ...(args.workflowName !== undefined && {
          workflowName: args.workflowName,
        }),
      })
    : null;

  const runId: string = recorder?.runId ?? randomUUID();
  const emitEvent: (event: WorkflowEngineEvent) => void =
    recorder !== null ? (e) => recorder.emit(e) : noopEmitEvent;
  // Refresh path: real runner dispatch so the agent sub-run gets a
  // parent_run_id. GET path: stubbed (see stubRunAgent).
  const runAgent: WorkflowEngineDependencies["runAgent"] =
    recorder !== null ? buildRealRunAgent(args.ownerId) : stubRunAgent;
  const deps = buildEngineDeps(catalog, emitEvent, runAgent);

  const abortController = new AbortController();
  const startedAt = Date.now();
  try {
    const result = await inProcessWorkflowEngine.execute(
      {
        workflowId: args.workflowId,
        runId,
        spec: args.spec,
        input: {},
        context: {},
        abortController,
      },
      deps,
    );
    const data = result.output[args.outputField];
    if (data === undefined) {
      log.warn(
        { outputField: args.outputField, availableKeys: Object.keys(result.output) },
        "workflow output missing requested field",
      );
      // Engine succeeded but the requested field wasn't produced —
      // finalize the recorded run as "succeeded" and return null;
      // the workflow_completed event in the timeline retains the
      // "ran but yielded no data for outputField=X" detail.
      if (recorder !== null) await recorder.succeed();
      return null;
    }
    if (recorder !== null) await recorder.succeed();
    return {
      data,
      // L2 cache not implemented — always false. `forceFresh` is a
      // no-op until L2 lands.
      fromCache: false,
      executedAt: new Date(),
    };
  } catch (err) {
    if (err instanceof WorkflowError) {
      log.warn(
        {
          durationMs: Date.now() - startedAt,
          errorCode: err.errorCode,
          message: err.message,
          nodeId: err.nodeId,
        },
        "workflow resolve failed",
      );
      if (recorder !== null) await recorder.fail(err);
      return null;
    }
    if (recorder !== null) await recorder.fail(err);
    throw err;
  }
}

// ─── Engine deps assembly ──────────────────────────────────────────────

function buildEngineDeps(
  catalog: Map<string, ToolDefinition>,
  emitEvent: (event: WorkflowEngineEvent) => void,
  runAgent: WorkflowEngineDependencies["runAgent"],
): WorkflowEngineDependencies {
  return {
    getTool: (name: string): ToolHandle | null => {
      const def = catalog.get(name);
      return def === undefined ? null : adaptToolHandle(def);
    },
    runAgent,
    runCode: runCodeViaSandbox,
    emitEvent,
    // cache omitted — see file header
  };
}

/** Bridge from the engine's `runCode` contract to the active
 *  sandbox adapter. Adding a new language means extending
 *  `languageCommand` AND `CodeLanguageSchema`. */
async function runCodeViaSandbox(
  req: CodeRunRequest,
): Promise<CodeRunResult> {
  const command = languageCommand(req.language);
  const adapter = await getActiveAdapter();
  const result = await adapter.run({
    command,
    stdin: req.code,
    datasets: req.datasets,
    timeoutMs: req.timeoutMs,
    signal: req.abortSignal,
    // `env` plumb-through: sandbox adapters don't yet accept a
    // per-call env overlay (only the operator-tuned allowlist).
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  };
}

function languageCommand(language: CodeRunRequest["language"]): string[] {
  switch (language) {
    case "python":
      return ["python3", "-"];
  }
}

/** Convert a `ToolDefinition` (Vercel AI SDK shape:
 *  `execute(args, ctx?)`) to the engine's `ToolHandle` shape
 *  (`execute({ input, abortSignal, context })`). abortSignal /
 *  context are not forwarded; tools use process-level cancellation
 *  and AsyncLocalStorage for user context. */
function adaptToolHandle(def: ToolDefinition): ToolHandle {
  return {
    execute: async ({ input, abortSignal, context }) => {
      void abortSignal;
      void context;
      const executor = def.execute as (args: unknown) => Promise<unknown>;
      return executor(input);
    },
  };
}

/**
 * GET-path fallback. Agent nodes encountered during passive viewing
 * throw rather than dispatching — real dispatch would create an
 * unparented entity_run sub-run and violate the "GET writes
 * nothing" invariant. Refresh-path agent nodes use
 * `buildRealRunAgent` instead.
 */
async function stubRunAgent(_req: AgentRunRequest): Promise<AgentRunResult> {
  void _req;
  throw new WorkflowError({
    errorCode: "AGENT_EXECUTION_FAILED",
    message:
      "Agent nodes can only execute on the refresh (POST /api/artifacts/[id]/refresh) path. " +
      "Passive GET requests skip agent dispatch to keep the run log clean.",
  });
}

/**
 * Refresh-path agent dispatcher — bridges the engine's `runAgent`
 * DI hook to `runner.start({ mode: "sync" })`. The sub-run is
 * parented to the workflow's `entity_run.id` so admin forensics
 * renders the tree; the depth-3 ceiling is enforced by the
 * runner's `RecursionDepthExceeded`.
 *
 * Any throw OR a non-"succeeded" status surfaces as
 * `AGENT_EXECUTION_FAILED` so the engine's retry machinery handles
 * agent failures uniformly.
 */
function buildRealRunAgent(
  ownerId: string,
): WorkflowEngineDependencies["runAgent"] {
  return async (req: AgentRunRequest): Promise<AgentRunResult> => {
    const task: string = extractTaskString(req.input);
    let result;
    try {
      result = await runner.start({
        entityId: req.agentId,
        // Built-in dispatch infers entityKind="agent" — workflow
        // agent nodes are always built-in (resolved at save time).
        task,
        context: req.input,
        mode: "sync",
        initiator: "user",
        ownerId,
        createdBy: ownerId,
        parentRunId: req.parentRunId,
      });
    } catch (err) {
      throw new WorkflowError({
        errorCode: "AGENT_EXECUTION_FAILED",
        message: err instanceof Error ? err.message : String(err),
        cause: err,
      });
    }

    if (result.status !== "succeeded") {
      throw new WorkflowError({
        errorCode: "AGENT_EXECUTION_FAILED",
        message:
          result.errorMessage ??
          `agent run finished with status: ${result.status}`,
      });
    }

    // Runner returns plain text; engine's schema validator confirms
    // shape matches the spec's `output_schema` (default
    // `{ text: string }`).
    return {
      output: { text: result.summary },
      childRunId: result.runId,
    };
  };
}

/** Pull a natural-language prompt from `input` — chat captures
 *  store it under `text`; other shapes round-trip through JSON.
 *  Falls back to a placeholder so the prompt is never blank. */
function extractTaskString(input: Record<string, unknown>): string {
  if (typeof input.text === "string" && input.text.length > 0) {
    return input.text;
  }
  const serialised = JSON.stringify(input);
  return serialised === "{}" ? "(empty workflow agent input)" : serialised;
}

function noopEmitEvent(): void {
  // GET path: events fire from the engine but we throw them away.
  // See file header.
}
