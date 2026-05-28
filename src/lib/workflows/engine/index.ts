/**
 * Workflow engine public surface — interface + DI types only.
 *
 * V1 ships exactly one implementation (`InProcessWorkflowEngine`,
 * `in-process.ts`); the abstract interface exists so V2 can slot in
 * `EventedWorkflowEngine` / `RemoteWorkflowEngine` without rewriting
 * call sites (§3.7.2, §7.8).
 *
 * The interface is **dependency-injection-shaped**: the engine never
 * imports `src/lib/runner/` directly. Instead, the calling shim
 * (`src/lib/runner/dispatch/workflow.ts`) supplies the runner's
 * `runAgent` callback through `WorkflowEngineDependencies`, breaking
 * the runner ↔ workflows cycle that would otherwise form (D17).
 */

import type { CanonicalWorkflowSpec } from "../spec/schema";
import type { WorkflowCache } from "./cache";

export type { WorkflowCache } from "./cache";

// ─── Execution input/output (engine boundary) ──────────────────────────

/**
 * Parameters for one workflow run. Constructed by the runner-side
 * dispatch shim from a `runner.start()` request plus the resolved
 * workflow row.
 *
 * V1 omits the resume/snapshot/initialState fields from the doc's
 * full interface (§7.8) — suspend/resume is deferred to V1.1 (D25).
 */
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
   * Execution context for `@context.<path>` refs (e.g. `today`,
   * `tenant`, `secrets`). Engine treats this as opaque — only the
   * ref resolver walks into it.
   */
  context: Record<string, unknown>;
  /**
   * Caller-owned cancellation. The engine forwards `abortSignal`
   * into every node executor; cancellation takes effect at the
   * next IO checkpoint inside each executor.
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
  /**
   * Resolved `spec.outputs` map (D28). Keys come from the spec's
   * top-level `outputs` declaration; values are the ref-resolved
   * upstream node outputs.
   */
  output: Record<string, unknown>;
  /**
   * Per-node output bag, keyed by numeric node id (D29). Useful
   * for cache population, admin forensics, and debug surfaces.
   */
  nodeOutputs: ReadonlyMap<number, Record<string, unknown>>;
}

// ─── Dependency injection ──────────────────────────────────────────────

/**
 * Tool-executor handle returned by the engine's tool registry
 * (server tools, MCP, HTTP, template — all unified behind one
 * `execute()` per D6 + D27). Resolved at *dispatch* time from
 * `WorkflowEngineDependencies.getTool(toolName)`; the engine does
 * NOT see server-vs-MCP distinction.
 */
export interface ToolHandle {
  /**
   * Execute the tool. The engine has already:
   *  - Resolved `@path` refs in `input`
   *  - Verified `node.input_schema.required` keys at save time
   *    (`validate.ts`)
   *
   * The handle returns the raw result; the engine maps it onto
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
  /** UUID resolved at save time by canonicalize (D27). */
  agentId: string;
  /** Ref-resolved input (engine resolves before calling). */
  input: Record<string, unknown>;
  /**
   * Output schema the agent must conform to (default: D30's
   * `{ text: string }`). Runner wraps natural-language replies
   * accordingly.
   */
  outputSchema: Record<string, unknown>;
  abortSignal: AbortSignal;
  /** Parent run for `parent_run_id` linkage (AGENTS.md §11). */
  parentRunId: string;
  /** D16 — filter applied by the runner before agent dispatch. */
  excludeFrontendTools: true;
}

export interface AgentRunResult {
  /** Structured result matching `outputSchema`. */
  output: Record<string, unknown>;
  /** Sub-run id for the agent invocation (for run-tree linkage). */
  childRunId: string;
}

/**
 * Code-node dispatch request (D35) — engine → sandbox adapter via DI.
 *
 * The engine resolves refs in `node.input` to the literal values
 * below before calling. `datasets` is the resolved string array of
 * dataset names to expose read-only inside the sandbox cwd; `env`
 * (V1.x — not yet wired) carries scalar inputs as env vars.
 */
export interface CodeRunRequest {
  language: "python";
  code: string;
  /** Dataset names to expose read-only at `./data/<name>/` in the sandbox cwd. */
  datasets: string[];
  /** Optional env-var overlay (V1.x reserved). */
  env: Record<string, string>;
  /** Effective timeout in milliseconds — already merged with engine
   *  defaults so the adapter can use it directly. */
  timeoutMs: number;
  abortSignal: AbortSignal;
}

/**
 * Code-node dispatch result — the raw `SandboxOutput` envelope.
 *
 * The engine inspects `exitCode` to decide success vs failure
 * (`exitCode !== 0` → CODE_EXECUTION_FAILED with `stderr` surfaced
 * in the message). On success, the engine either:
 *   - exposes `{ stdout, stderr, exitCode, durationMs }` as the
 *     node's outputs when no `output_schema` is declared, or
 *   - `JSON.parse(stdout)` + validates against the declared
 *     `output_schema` and exposes the parsed object's top-level
 *     keys.
 */
export interface CodeRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/**
 * Engine emits one event per execution milestone. The runner-side
 * adapter (`dispatch/workflow.ts`) translates these to
 * `entity_run_event` rows; see `docs/runner-events.md` for the
 * AG-UI ↔ EntityRunEventType reference table.
 *
 * V1 emits 4 kinds (per §4.4 + §7.2). `workflow_started` /
 * `workflow_completed` / `workflow_failed` bracket the run;
 * `workflow_node_attempt_started` / `_failed` / `_completed`
 * bracket each node attempt.
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
      /**
       * Whether this node's outputs came from the per-node cache
       * (D20 Plan C) rather than a fresh executor call. Absent
       * (= false) for normal completions. Admin run forensics
       * surfaces this — same node id but `cached: true` vs no flag
       * tells the operator whether the work was actually done.
       */
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
 * the runner-side dispatch shim. The engine module never imports
 * runner/ directly (D17 cycle break).
 */
export interface WorkflowEngineDependencies {
  /**
   * Look up a tool handle by tool name. Returns `null` if the tool
   * is no longer registered (engine throws `TOOL_NOT_FOUND` for
   * the node — same code path as canonicalize's save-time check).
   */
  getTool(toolName: string): ToolHandle | null;

  /**
   * Dispatch an agent invocation. Injected to break the
   * runner ↔ workflows cycle (D17). Runner-side wires this to
   * `runner.start({ kind: 'agent', ... })` with `parent_run_id` set
   * for run-tree linkage.
   *
   * The runner is responsible for applying the D16 frontend-tool
   * filter before invoking the agent — engine signals intent via
   * `excludeFrontendTools: true`.
   */
  runAgent(req: AgentRunRequest): Promise<AgentRunResult>;

  /**
   * Dispatch a sandboxed code execution (D35). Injected so the
   * engine module stays decoupled from `lib/sandbox/`. The
   * production adapter wires this to
   * `getActiveAdapter().run({...})` mapping
   * `language → command`. Tests inject stubs.
   */
  runCode(req: CodeRunRequest): Promise<CodeRunResult>;

  /**
   * Emit an engine event. Synchronous from the engine's POV — the
   * adapter handles fan-out to `entity_run_event` + the SSE bus.
   */
  emitEvent(event: WorkflowEngineEvent): void;

  /**
   * Optional per-node content-addressable cache (D20 Plan C,
   * §7.4). When supplied, the engine memoizes successful node
   * outputs by cache key — same node semantic + same resolved
   * input hits the cache regardless of which workflow contains
   * the node. Cache hits emit a synthetic `workflow_node_completed`
   * event with `cached: true` and `durationMs: 0`.
   */
  cache?: WorkflowCache;
}

// ─── Engine interface ──────────────────────────────────────────────────

/**
 * Workflow execution engine — V1 has exactly one implementation
 * (`InProcessWorkflowEngine`); the abstraction exists for V2 swap-
 * out (§7.8).
 */
export interface WorkflowEngine {
  execute(
    params: ExecuteParams,
    deps: WorkflowEngineDependencies,
  ): Promise<WorkflowResult>;
}
