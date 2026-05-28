/**
 * Production `executeWorkflow` implementation — replaces the
 * W1.6.2 stub. Wires `inProcessWorkflowEngine` to the user-scoped
 * tool catalog and surfaces the result as a `DataResolution`.
 *
 * Composition:
 *   buildUserToolCatalog(ownerId)
 *      → Map<name, ToolDefinition>
 *      → adapter to `ToolHandle` (`getTool` lookup)
 *           ↓
 *   WorkflowEngineDependencies = { getTool, runAgent (stub),
 *                                  emitEvent (no-op), cache (optional) }
 *           ↓
 *   inProcessWorkflowEngine.execute(params, deps)
 *           ↓
 *   { runId, output, nodeOutputs }
 *           ↓
 *   pick `output[outputField]` → DataResolution { data, fromCache,
 *                                                  executedAt }
 *
 * V1.7 simplifications (each tracked for follow-up):
 *   - `runAgent` dispatches via `runner.start({mode: "sync"})` on
 *     the refresh (`forceFresh: true`) path, with the workflow's
 *     entity_run id as parent_run_id so the agent's sub-run hangs
 *     off the workflow run in admin run forensics. The GET path
 *     (no recorder, no forceFresh) keeps the original W1.7 stub
 *     behaviour — agent nodes encountered during passive viewing
 *     still throw AGENT_EXECUTION_FAILED. This asymmetry preserves
 *     the D4a Strategy B invariant that GET writes nothing to
 *     entity_run (an unparented agent sub-run from a passive view
 *     would violate that). V1 agent dispatch uses the D30 default
 *     `{ text: string }` output schema — the runner's `summary`
 *     wraps as `{ text: summary }`; non-default schemas
 *     (custom `output_schema` on the spec) fail loud at the
 *     engine's schema-validation step.
 *   - `emitEvent` persists events to `entity_run_event` ONLY when
 *     `forceFresh: true` (deliberate refresh action — D4a). GET
 *     paths still emit no events because flooding the run log with
 *     passive artifact-page views would drown deliberate refreshes
 *     in noise. The non-persisting path uses the local
 *     `noopEmitEvent` shim; the persisting path wires a
 *     `WorkflowRunRecorder` that creates an entity_run row + writes
 *     events as the engine fires them.
 *     @see ./workflow-run-recorder.ts
 *   - `cache` is not provided (L1 per-node cache singleton TBD).
 *     Every node re-executes on every resolve. Acceptable for V1
 *     small specs (~10 nodes max, sub-second total).
 *     [W1.7.x — InProcessLruCache singleton injection.]
 *   - L2 workflow-output cache is not implemented. `fromCache` is
 *     always false in W1.7. The `forceFresh` hint passed by the
 *     refresh endpoint is therefore a no-op today (the engine
 *     ALWAYS runs fresh).
 *     [V1.x — hash(spec, inputs)-keyed Level 2 cache.]
 *
 * Error handling:
 *   - `WorkflowError` from the engine is caught and surfaced as
 *     `null` (DataResolution absent) → bundle ships without `data`.
 *     Future: include the error in the bundle (`bundle.dataError`)
 *     so the artifact page can show a specific failure message.
 *   - Unexpected throws propagate — the route handler's standard
 *     error envelope catches them.
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
   *  ("Refresh workflow: <name>"). When omitted the recorder falls
   *  back to a generic "Workflow refresh" label. Only consumed when
   *  `forceFresh: true` triggers recording. */
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

  // D4a: persist a forensic entity_run + event timeline ONLY when
  // forceFresh=true (deliberate refresh). GET paths skip recording
  // to keep the run log focused on user intent. `recorder` is null
  // when either (a) forceFresh wasn't set, or (b) recordRunStart
  // itself failed — both paths fall through to noopEmitEvent and
  // use a request-local randomUUID runId for engine-event
  // correlation (which won't be persisted anywhere).
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
  // GET path: agent nodes stay stubbed (preserves D4a Strategy B —
  // no unparented agent sub-runs from passive views). Refresh path:
  // real dispatch through the runner so the agent sub-run gets a
  // parent_run_id pointing at the workflow's entity_run row.
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
      // Engine completed successfully but the requested output
      // field wasn't produced — finalize the recorded run as
      // "succeeded" (the workflow ran) even though we return null
      // here. The downstream bundle ships without data; the
      // forensic record reflects "ran but yielded no data for
      // outputField=X", queryable via the workflow_completed
      // event in the timeline.
      if (recorder !== null) await recorder.succeed();
      return null;
    }
    if (recorder !== null) await recorder.succeed();
    return {
      data,
      // L2 cache not implemented in W1.7 — always false. forceFresh
      // is a no-op until L2 lands.
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

/**
 * Bridge from the engine's `runCode` contract to the active sandbox
 * adapter (D35). The engine builds the high-level request (language,
 * code, datasets, env, timeout); this shim maps that to the
 * sandbox's `SandboxInput` shape and unwraps the result.
 *
 * `language` → `command` mapping is centralised here so the engine
 * never carries an interpreter binary name. Adding a new language
 * means extending this table AND the schema's
 * `CodeLanguageSchema` enum.
 */
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
    // `env` plumb-through: V1.x sandbox adapters don't yet accept
    // a per-call env overlay (only the operator-tuned allowlist).
    // The engine's `env` field is reserved for the time the
    // adapter contract gains it — the spec carrying refs in
    // `inputs.env` will then become live without further engine
    // changes.
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

/**
 * Convert a Vercel-AI-SDK-shaped `ToolDefinition` to the engine's
 * `ToolHandle` contract.
 *
 * Vercel AI SDK calls `execute(args, ctx?)` where `args` is the
 * parsed parameters object. The engine calls
 * `execute({ input, abortSignal, context })`. We map `input` →
 * positional `args`. The engine's `abortSignal` / `context` are
 * not currently forwarded — tools that need an abort signal can
 * use process-level cancellation; user-context is implicit in the
 * AsyncLocalStorage maintained by Next.js / the runner.
 *
 * V1.x: when we add abortable tools (long-running SQL / HTTP),
 * extend the second arg of `def.execute` with `{ abortSignal }`.
 */
function adaptToolHandle(def: ToolDefinition): ToolHandle {
  return {
    execute: async ({ input, abortSignal, context }) => {
      void abortSignal;
      void context;
      // ToolDefinition.execute accepts `(args, ctx?)` in AI SDK
      // typing; we call with one arg (the parsed input).
      const executor = def.execute as (args: unknown) => Promise<unknown>;
      return executor(input);
    },
  };
}

/**
 * GET-path fallback. Strategy B (D4a): agent nodes encountered
 * during passive viewing throw rather than dispatching, because
 * real dispatch would create an unparented entity_run sub-run and
 * violate the "GET writes nothing" invariant. Refresh-path agent
 * nodes go through `buildRealRunAgent` instead.
 */
async function stubRunAgent(_req: AgentRunRequest): Promise<AgentRunResult> {
  void _req;
  throw new WorkflowError({
    errorCode: "AGENT_EXECUTION_FAILED",
    message:
      "Agent nodes can only execute on the refresh (POST /api/artifacts/[id]/refresh) path. " +
      "Passive GET requests skip agent dispatch to keep the run log clean (D4a Strategy B).",
  });
}

/**
 * Refresh-path agent dispatcher (D4a + W2). Bridges the engine's
 * `runAgent` DI hook to the runner's programmatic sync API — the
 * same code path supervisor delegation uses.
 *
 * Plumbed fields:
 *   - `parentRunId` from the engine = the workflow's `entity_run.id`
 *     (recorder runId). Runner records the agent's sub-run with
 *     this parent so admin run forensics renders the workflow run
 *     and its agent children as a tree. `RecursionDepthExceeded`
 *     from event-store guards the depth-3 ceiling.
 *   - `task` = a string extracted from `input` (the D30 capture
 *     stores chat-style prompts under `input.text`). Falls back to
 *     a JSON serialisation when the convention isn't followed.
 *     The engine validates the agent's returned shape against the
 *     spec's `output_schema` (default `{ text: string }`) one
 *     layer up in `agent-node.ts`.
 *   - `initiator: "user"` — refresh is an explicit user action.
 *     Sub-run inherits ownerId so the user sees their own runs in
 *     admin forensics filters.
 *
 * Error handling: non-WorkflowError throws (e.g.
 * `RecursionDepthExceeded`, network failures, runner internals)
 * are wrapped as `AGENT_EXECUTION_FAILED` so the engine's
 * `with-retries` machinery handles them uniformly. A run that
 * finishes in any non-"succeeded" status is also surfaced as
 * `AGENT_EXECUTION_FAILED` with the runner's `errorMessage`.
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
        // Workflow agent nodes are always built-in in V1 (canonicalize
        // resolves agentId against the BuiltinAgent registry at save
        // time). Built-in dispatch infers entityKind="agent"
        // internally via classifyDispatchTarget, so leaving it
        // unset is correct here.
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

    // D30 wrap: runner returns plain text; engine's downstream
    // schema validator confirms shape matches the spec's
    // `output_schema`. With the V1 default that's `{ text: string }`.
    return {
      output: { text: result.summary },
      childRunId: result.runId,
    };
  };
}

/**
 * Pull a natural-language prompt from the engine's `input` object.
 * The save pipeline captures chat agent invocations into the
 * `text` key (D30); other shapes round-trip through JSON. Never
 * returns the empty string — empty input falls back to a placeholder
 * so the agent's user message isn't blank.
 */
function extractTaskString(input: Record<string, unknown>): string {
  if (typeof input.text === "string" && input.text.length > 0) {
    return input.text;
  }
  const serialised = JSON.stringify(input);
  return serialised === "{}" ? "(empty workflow agent input)" : serialised;
}

function noopEmitEvent(): void {
  // GET path (forceFresh !== true): events fire from the engine
  // but we throw them away. See file header — passive page views
  // shouldn't pollute the run log; only refresh writes entity_run.
}
