/**
 * Workflow engine public surface — interface + DI types only.
 *
 * The interface is dependency-injection-shaped: the engine never
 * imports `src/lib/runner/` directly. The calling shim
 * (`src/lib/runner/dispatch/workflow.ts`) supplies the runner's
 * `runAgent` / `runCode` callbacks via `WorkflowEngineDependencies`.
 *
 * See docs/workflow.md.
 */

import type { CanonicalWorkflowSpec } from "../spec/schema";
import type { WorkflowCache } from "./cache";

export type { WorkflowCache } from "./cache";

// ─── Execution input/output (engine boundary) ──────────────────────────

/** Parameters for one workflow run. */
export interface ExecuteParams {
  /** Stable id of the workflow row (FK target). */
  workflowId: string;
  /** Stable id of the surrounding `entity_run` row (event correlation). */
  runId: string;
  /** Canonical, validated spec — output of `canonicalize` + `validate`. */
  spec: CanonicalWorkflowSpec;
  /** Workflow-level inputs (`@workflow.<key>` refs). */
  input: Record<string, unknown>;
  /**
   * Execution context for `@context.<path>` refs. Engine treats this
   * as opaque — only the ref resolver walks into it.
   */
  context: Record<string, unknown>;
  /**
   * Caller-owned cancellation. The engine forwards `abortSignal` into
   * every node executor; cancellation takes effect at the next IO
   * checkpoint inside each executor.
   */
  abortController: AbortController;
}

/**
 * Successful workflow run result. Failure propagates as a thrown
 * `WorkflowError` (caller's `toResult()` boundary converts it).
 */
export interface WorkflowResult {
  ok: true;
  runId: string;
  /** Resolved `spec.outputs` map. */
  output: Record<string, unknown>;
  /** Per-node output bag, keyed by numeric node id. */
  nodeOutputs: ReadonlyMap<number, Record<string, unknown>>;
}

// ─── Dependency injection ──────────────────────────────────────────────

/**
 * Tool-executor handle returned by the engine's tool registry.
 * Resolved at dispatch time from `WorkflowEngineDependencies.getTool`;
 * the engine does NOT see server-vs-MCP distinction.
 */
export interface ToolHandle {
  /**
   * Execute the tool. The engine has already resolved `@path` refs in
   * `input` and verified `node.input_schema.required` keys at save
   * time. The handle returns the raw result; the engine maps it onto
   * `outputs[]` per the canonical node's declared schema.
   */
  execute(args: {
    input: Record<string, unknown>;
    abortSignal: AbortSignal;
    context: Readonly<Record<string, unknown>>;
  }): Promise<unknown>;
}

/** Agent-node dispatch request — engine → runner via DI. */
export interface AgentRunRequest {
  /** UUID resolved at save time by canonicalize. */
  agentId: string;
  /** Ref-resolved input (engine resolves before calling). */
  input: Record<string, unknown>;
  /** Output schema the agent must conform to. */
  outputSchema: Record<string, unknown>;
  abortSignal: AbortSignal;
  /** Parent run for `parent_run_id` linkage. */
  parentRunId: string;
  /** Runner applies the frontend-tool filter before agent dispatch. */
  excludeFrontendTools: true;
}

export interface AgentRunResult {
  /** Structured result matching `outputSchema`. */
  output: Record<string, unknown>;
  /** Sub-run id for the agent invocation (for run-tree linkage). */
  childRunId: string;
}

/**
 * Code-node dispatch request — engine → sandbox adapter via DI.
 *
 * The engine resolves refs in `node.input` to the literal values
 * below before calling. `datasets` is the resolved string array of
 * dataset names to expose read-only inside the sandbox cwd.
 */
export interface CodeRunRequest {
  language: "python";
  code: string;
  /** Dataset names to expose read-only at `./data/<name>/` in the sandbox cwd. */
  datasets: string[];
  /** Optional env-var overlay. */
  env: Record<string, string>;
  /** Effective timeout in milliseconds — already merged with engine defaults. */
  timeoutMs: number;
  abortSignal: AbortSignal;
}

/**
 * Code-node dispatch result — the raw `SandboxOutput` envelope.
 *
 * The engine inspects `exitCode` to decide success vs failure
 * (`exitCode !== 0` → CODE_EXECUTION_FAILED with `stderr` surfaced
 * in the message). On success, the engine either exposes
 * `{ stdout, stderr, exitCode, durationMs }` as the node's outputs
 * when no `output_schema` is declared, or `JSON.parse(stdout)` +
 * validates against the declared `output_schema` and exposes the
 * parsed object's top-level keys.
 */
export interface CodeRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/**
 * Engine emits one event per execution milestone. The runner-side
 * adapter translates these to `entity_run_event` rows; see
 * docs/runner-events.md for the AG-UI ↔ EntityRunEventType table.
 */
export type WorkflowEngineEvent =
  | { type: "workflow_started"; runId: string }
  | {
      type: "workflow_node_attempt_started";
      runId: string;
      nodeId: number;
      attempt: number;
    }
  | {
      type: "workflow_node_attempt_failed";
      runId: string;
      nodeId: number;
      attempt: number;
      errorCode: string;
      message: string;
    }
  | {
      type: "workflow_node_completed";
      runId: string;
      nodeId: number;
      attempt: number;
      durationMs: number;
      outputs: Record<string, unknown>;
      /** True when outputs came from the per-node cache (vs a fresh executor call). */
      cached?: boolean;
    }
  | {
      type: "workflow_completed";
      runId: string;
      output: Record<string, unknown>;
    }
  | {
      type: "workflow_failed";
      runId: string;
      errorCode: string;
      message: string;
      nodeId?: number;
    };

/**
 * Everything the engine needs from the outside world. Injected by
 * the runner-side dispatch shim — the engine never imports runner/.
 */
export interface WorkflowEngineDependencies {
  /**
   * Look up a tool handle by tool name. Returns `null` if the tool
   * is no longer registered (engine throws `TOOL_NOT_FOUND`).
   */
  getTool(toolName: string): ToolHandle | null;

  /**
   * Dispatch an agent invocation. Runner-side wires this to
   * `runner.start({ entityKind: 'agent', ... })` with `parent_run_id`
   * set for run-tree linkage. Runner is responsible for applying the
   * frontend-tool filter before invoking the agent.
   */
  runAgent(req: AgentRunRequest): Promise<AgentRunResult>;

  /**
   * Dispatch a sandboxed code execution. Production adapter wires
   * this to `getActiveAdapter().run({...})` mapping
   * `language → command`. Tests inject stubs.
   */
  runCode(req: CodeRunRequest): Promise<CodeRunResult>;

  /**
   * Emit an engine event. Synchronous from the engine's POV — the
   * adapter handles fan-out to `entity_run_event` + the SSE bus.
   */
  emitEvent(event: WorkflowEngineEvent): void;

  /**
   * Optional per-node content-addressable cache. Same node semantic
   * + same resolved input hits the cache regardless of which
   * workflow contains the node. Cache hits emit a synthetic
   * `workflow_node_completed` event with `cached: true` and
   * `durationMs: 0`. See docs/workflow.md.
   */
  cache?: WorkflowCache;
}

// ─── Engine interface ──────────────────────────────────────────────────

/** Workflow execution engine. */
export interface WorkflowEngine {
  execute(
    params: ExecuteParams,
    deps: WorkflowEngineDependencies,
  ): Promise<WorkflowResult>;
}
