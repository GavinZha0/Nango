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
import { SANDBOX_PARAMS_ENV_KEY } from "@/lib/sandbox/types";
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
 *  `languageCommand`, `buildPythonStdin`, AND `CodeLanguageSchema`. */
async function runCodeViaSandbox(
  req: CodeRunRequest,
): Promise<CodeRunResult> {
  const command = languageCommand(req.language);
  const adapter = await getActiveAdapter();
  // Build the full stdin payload: preamble (datasets/params bindings)
  // followed by either the inline code text or a preamble+exec-wrapper
  // that executes the sandbox-resident file in the current scope.
  const stdin = buildSandboxStdin(req.language, req.datasets, req.env, req.code, req.codeFile);
  const result = await adapter.run({
    command,
    stdin,
    datasets: req.datasets,
    env: Object.keys(req.env).length > 0 ? req.env : undefined,
    timeoutMs: req.timeoutMs,
    signal: req.abortSignal,
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
    case "javascript":
      // `node -` reads script from stdin in CommonJS mode.
      // ES module syntax (import/export at the top level) is NOT
      // supported — use require(). To enable ESM, the caller would
      // need "--input-type=module" instead.
      return ["node", "-"];
  }
}

/**
 * Build the complete stdin payload for a code-node execution.
 *
 * Two modes, unified via stdin → `python3 -`:
 *
 *  **code_text** (`code` is set):
 *    `<preamble>\n<user code>`
 *    Preamble defines `datasets` / `params`; user code follows inline.
 *
 *  **code_file** (`codeFile` is set):
 *    `<preamble>\nexec(compile(open('./code/<file>').read(), ...))`
 *    Preamble runs first (same scope); then `exec` runs the file so
 *    preamble-defined `datasets` / `params` are visible to file code.
 *    `compile(src, filename, 'exec')` sets the co_filename so tracebacks
 *    reference the real file path rather than `<stdin>`.
 *
 * Adding a new language (e.g. JavaScript) requires a new `case` here
 * and a new entry in `languageCommand`.
 */
function buildSandboxStdin(
  language: CodeRunRequest["language"],
  datasets: string[],
  env: Record<string, string>,
  code: string | undefined,
  codeFile: string | undefined,
): string {
  switch (language) {
    case "python":
      return buildPythonStdin(datasets, env[SANDBOX_PARAMS_ENV_KEY], code, codeFile);
    case "javascript":
      // validate.ts rejects JS + datasets and JS + code_file at save time,
      // so neither can reach this branch. Pass only paramsJson + code.
      return buildJavaScriptStdin(env[SANDBOX_PARAMS_ENV_KEY], code);
  }
}

function buildPythonStdin(
  datasets: string[],
  paramsJson: string | undefined,
  code: string | undefined,
  codeFile: string | undefined,
): string {
  const lines: string[] = [];
  if (paramsJson !== undefined) {
    lines.push("import json as __nango_json, os as __nango_os");
  }
  if (datasets.length > 0) {
    // Embed dataset names directly — they are plain strings, not typed
    // data, and embedding avoids an extra env var round-trip.
    lines.push(`datasets = ${JSON.stringify(datasets)}`);
  }
  if (paramsJson !== undefined) {
    // Read the JSON-serialized params from the env var set by the
    // engine. json.loads preserves int / float / bool / list shapes;
    // env var transport keeps the serialization boundary clean.
    lines.push(`params = __nango_json.loads(__nango_os.environ['${SANDBOX_PARAMS_ENV_KEY}'])`);
  }
  const preamble = lines.length > 0 ? lines.join("\n") + "\n" : "";

  if (code !== undefined) {
    // Inline text mode — append user code after preamble.
    return preamble + code;
  }
  // File mode — exec the file so preamble vars remain in scope.
  // Using exec(compile(...)) rather than exec(open(...).read()) so that
  // the co_filename in compiled bytecode is the real path, giving
  // readable tracebacks (e.g. "main.py, line 5" not "<stdin>, line 5").
  const filePath = `./code/${codeFile!}`;
  const execLine =
    `exec(compile(open(${JSON.stringify(filePath)}).read(), ` +
    `${JSON.stringify(filePath)}, 'exec'))`;
  return preamble + execLine + "\n";
}

/**
 * Build the stdin payload for a JavaScript code node.
 *
 * v1 constraints (enforced by validate.ts before this is called):
 *  - Only `code_text` mode — `code_file` is rejected at save time.
 *  - No `datasets` — Node.js v1 runtime has no Parquet reader.
 *  - CommonJS mode — `import` / `export` are not supported; use
 *    `require()`. The entrypoint runs under `node -` (stdin script).
 *
 * `params` is the only preamble binding: one JSON.parse line that
 * reads SANDBOX_PARAMS_ENV_KEY from the process env. See
 * docs/workflow-spec.md for the engine-injected variables contract.
 */
function buildJavaScriptStdin(
  paramsJson: string | undefined,
  code: string | undefined,
): string {
  const preamble = paramsJson !== undefined
    ? `const params = JSON.parse(process.env[${JSON.stringify(SANDBOX_PARAMS_ENV_KEY)}] ?? '{}');\n`
    : "";
  return preamble + (code ?? "");
}

/** Convert a `ToolDefinition` (CopilotKit shape:
 *  `execute(args, ctx?)`) to the engine's `ToolHandle` shape
 *  (`execute({ input, abortSignal, context })`).
 *
 *  `abortSignal` is forwarded as `ctx.abortSignal` so tools that
 *  opt into cancellation (`web_search`, `run_ssh_command`, …) can
 *  compose it with their own timeout controllers. Tools that don't
 *  accept a second parameter simply ignore it (JS discards extra
 *  positional args). */
function adaptToolHandle(def: ToolDefinition): ToolHandle {
  return {
    execute: async ({ input, abortSignal }) => {
      const executor = def.execute as (
        args: unknown,
        ctx?: { abortSignal?: AbortSignal },
      ) => Promise<unknown>;
      return executor(input, { abortSignal });
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
    // shape matches the spec's canonical `output_schema`
    // (`AGENT_NODE_OUTPUT_SCHEMA` — `{ result: string }`).
    return {
      output: { result: result.summary },
      childRunId: result.runId,
    };
  };
}

/** Pull a natural-language prompt from `input` — the agent-node
 *  executor passes `{ task, context? }` (resolved from
 *  `node.inputs.task` and `node.inputs.context`). `context`
 *  appears after a blank line so the agent sees task + background
 *  in a familiar prompt layout. Falls back to a placeholder so the
 *  prompt is never blank. */
function extractTaskString(input: Record<string, unknown>): string {
  const task = typeof input.task === "string" ? input.task.trim() : "";
  const context = typeof input.context === "string" ? input.context.trim() : "";
  if (task.length > 0 && context.length > 0) {
    return `${task}\n\nContext:\n${context}`;
  }
  if (task.length > 0) return task;
  if (context.length > 0) return context;
  const serialised = JSON.stringify(input);
  return serialised === "{}" ? "(empty workflow agent input)" : serialised;
}

function noopEmitEvent(): void {
  // GET path: events fire from the engine but we throw them away.
  // See file header.
}
