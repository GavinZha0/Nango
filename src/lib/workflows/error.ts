/**
 * Workflow error contract — engine-internal `WorkflowError` class
 * plus the wire-shape `WorkflowErrorResult` and the single
 * boundary-conversion helper `toResult()`.
 *
 * Design — see docs/workflow-architecture.md §7.9 for the full
 * rationale. Briefly:
 *
 * - The class is thrown inside the engine (spec validation /
 *   resolution / node execution). `instanceof WorkflowError` is
 *   checked ONLY inside `src/lib/workflows/` — external consumers
 *   work off the plain-object `WorkflowErrorResult` shape (mirrors
 *   `web-search/errors.ts`'s "no instanceof outside this module"
 *   rule).
 * - At the engine's top-level catch boundary, call `toResult(we)`
 *   ONCE; the resulting plain object flows uniformly to all three
 *   consumers:
 *     1. `defineTool` execute() returns it to the LLM
 *        (modify_workflow / invoke_workflow / etc.)
 *     2. `entity_run.errorDetails` JSONB column persists it for
 *        admin forensics at `/admin/run/[id]`
 *     3. HTTP route handlers return `NextResponse.json(result)`
 *        with status 200 — workflow execution failure is a
 *        business-level outcome, NOT an HTTP-layer error.
 *
 * Field-naming convention reflects defineTool tool-return shape:
 *   `error: <code>` + `message: <text>` (see e.g.
 *   `data-sources/lookup.ts`:
 *      `{ ok: false, error: "NOT_FOUND", message: "..." }`).
 * The class field is named `errorCode` for unambiguous semantics
 * inside engine code; `toResult()` renames to `error` on the wire.
 */

/**
 * Closed enum of failure categories — V1 surface. The agent's
 * `modify_workflow` system prompt inlines this list so the LLM can
 * pattern-match on `error` reliably.
 *
 * V1.1+ codes (`CONDITION_EVALUATION_ERROR`, `SUSPEND_TIMEOUT`)
 * are intentionally absent — V1 spec validation rejects condition
 * nodes (D23) and suspend calls (D25) with
 * `SPEC_FEATURE_UNSUPPORTED` instead.
 */
export type WorkflowErrorCode =
  // ─── spec validation (statically detected; before any dispatch) ────
  | "SPEC_INVALID_JSON"
  | "SPEC_SCHEMA_MISMATCH"
  | "SPEC_VERSION_MISMATCH"
  | "SPEC_DAG_CYCLE"
  | "SPEC_NO_OUTPUTS" // spec.outputs missing/empty (D28)
  | "SPEC_REF_UNREACHABLE"
  | "SPEC_REF_UNKNOWN_NODE"
  | "SPEC_REF_UNKNOWN_FIELD"
  | "SPEC_DESCRIPTION_MISSING"
  | "SPEC_DISCRIMINATOR_AMBIGUOUS" // node has both `tool` AND `agent`
  | "SPEC_DISCRIMINATOR_MISSING"
  | "SPEC_FEATURE_UNSUPPORTED" // V1.1+ feature in V1 spec (D23 / D25)
  // ─── resolution (lookup / canonicalization) ────────────────────────
  | "TOOL_NOT_FOUND" // referenced tool no longer in registry
  | "AGENT_NOT_FOUND" // referenced agent no longer in catalog
  | "AGENT_SUPERVISOR_NOT_ALLOWED" // is_supervisor=true (D21)
  | "AGENT_UI_TOOLS_NOT_ALLOWED" // has frontend_tool in tool list (D21)
  | "TOOL_INPUT_SCHEMA_MISMATCH" // input fails tool.parameters
  | "AGENT_INPUT_INVALID"
  // ─── execution ─────────────────────────────────────────────────────
  | "TOOL_EXECUTION_FAILED"
  | "AGENT_EXECUTION_FAILED"
  | "CODE_EXECUTION_FAILED" // sandbox code node non-zero exitCode (D35)
  | "OUTPUT_SCHEMA_MISMATCH" // agent structured-output failed (§5.2.6)
  | "REF_UNRESOLVED" // saved ref → undefined at runtime (§7.10.3)
  | "PYTHON_RUNTIME_ERROR"
  | "SQL_SYNTAX_ERROR"
  | "SQL_PERMISSION_DENIED"
  | "HTTP_REQUEST_FAILED"
  | "NODE_TIMEOUT"
  | "WORKFLOW_TIMEOUT"
  | "OUTPUT_REF_UNRESOLVED" // spec.outputs entry's ref didn't resolve (D28)
  // ─── workflow-level ────────────────────────────────────────────────
  | "BUDGET_EXCEEDED" // modify_workflow retry budget (§7.9.5)
  | "UNKNOWN_ERROR"; // fallback — always populate `message`

/**
 * Codes that are workflow-scoped — they describe a failure that has
 * no single node to blame. For these, `nodeId` is omitted from the
 * error envelope. For every OTHER code, `nodeId` must be set
 * (contract enforced by code review; ~30 engine throw sites in V1).
 */
export const WORKFLOW_SCOPED_ERROR_CODES: readonly WorkflowErrorCode[] = [
  "SPEC_INVALID_JSON",
  "SPEC_VERSION_MISMATCH",
  "SPEC_NO_OUTPUTS",
  "OUTPUT_REF_UNRESOLVED",
  "SPEC_DAG_CYCLE",
  "WORKFLOW_TIMEOUT",
  "BUDGET_EXCEEDED",
  "UNKNOWN_ERROR",
] as const;

/**
 * Engine-internal throwable. See top-of-file comment + §7.9 for the
 * full contract.
 *
 * @example
 *   throw new WorkflowError({
 *     errorCode: "PYTHON_RUNTIME_ERROR",
 *     message: `Python failed in node ${node.id}:\n${e.message}`,
 *     nodeId: node.id,
 *     nodeName: node.tool ?? node.agent,
 *     cause: e,
 *   });
 */
export class WorkflowError extends Error {
  readonly errorCode: WorkflowErrorCode;
  /**
   * Numeric id of the failing node (D29). Required for node-scoped
   * codes; omitted for the codes listed in
   * {@link WORKFLOW_SCOPED_ERROR_CODES}.
   */
  readonly nodeId?: number;
  /**
   * Derived at throw time from `spec.nodes[nodeId].tool` or
   * `.agent`. Carries readability into `entity_run.errorDetails`
   * persistence — a stored error remains self-contained even after
   * later `modify_workflow` turns rewrite the spec.
   */
  readonly nodeName?: string;

  constructor(input: {
    errorCode: WorkflowErrorCode;
    message: string;
    nodeId?: number;
    nodeName?: string;
    cause?: unknown;
  }) {
    // ES2022 native `cause` chain. Available on the instance via
    // `we.cause` for developer logs; intentionally NOT serialized
    // into the wire envelope by `toResult()` (kept as engine-side
    // diagnostic only).
    super(input.message, { cause: input.cause });
    this.name = "WorkflowError";
    this.errorCode = input.errorCode;
    this.nodeId = input.nodeId;
    this.nodeName = input.nodeName;
  }
}

/**
 * The plain-object shape that all engine error consumers — LLM
 * `defineTool` returns, `entity_run.errorDetails` JSONB, HTTP route
 * bodies — work with. Produced by {@link toResult}.
 *
 * `error` is the wire-field name (matches Nango's defineTool
 * tool-return convention); it carries the same value as the class
 * field `errorCode`.
 */
export interface WorkflowErrorResult {
  ok: false;
  error: WorkflowErrorCode;
  message: string;
  nodeId?: number;
  nodeName?: string;
}

/**
 * Convert an engine-internal `WorkflowError` to the wire shape.
 * Called once at each engine top-level catch boundary
 * (e.g. `engine.execute()`, `engine.validateSpec()`).
 *
 * Conditional inclusion of `nodeId` / `nodeName` keeps the wire
 * envelope minimal for workflow-scoped errors.
 */
export function toResult(we: WorkflowError): WorkflowErrorResult {
  const result: WorkflowErrorResult = {
    ok: false,
    error: we.errorCode,
    message: we.message,
  };
  if (we.nodeId !== undefined) result.nodeId = we.nodeId;
  if (we.nodeName !== undefined) result.nodeName = we.nodeName;
  return result;
}
