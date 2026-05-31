/**
 * Workflow error contract — engine-internal `WorkflowError` class,
 * the wire-shape `WorkflowErrorResult`, and the boundary helper
 * `toResult()` that converts between them. See docs/workflow.md.
 */

/**
 * Closed enum of failure categories. The save pipeline and the
 * future workflow-rewrite chat path both pattern-match on `error`,
 * so the list must stay stable on the wire.
 */
export type WorkflowErrorCode =
  // ─── spec validation (statically detected; before any dispatch) ────
  | "SPEC_INVALID_JSON"
  | "SPEC_SCHEMA_MISMATCH"
  | "SPEC_VERSION_MISMATCH"
  | "SPEC_DAG_CYCLE"
  | "SPEC_NO_OUTPUTS"
  | "SPEC_REF_UNREACHABLE"
  | "SPEC_REF_UNKNOWN_NODE"
  | "SPEC_REF_UNKNOWN_FIELD"
  | "SPEC_DESCRIPTION_MISSING"
  | "SPEC_DISCRIMINATOR_AMBIGUOUS"
  | "SPEC_DISCRIMINATOR_MISSING"
  | "SPEC_FEATURE_UNSUPPORTED"
  // ─── resolution (lookup / canonicalization) ────────────────────────
  | "TOOL_NOT_FOUND"
  | "AGENT_NOT_FOUND"
  | "AGENT_SUPERVISOR_NOT_ALLOWED"
  | "AGENT_UI_TOOLS_NOT_ALLOWED"
  | "TOOL_INPUT_SCHEMA_MISMATCH"
  | "AGENT_INPUT_INVALID"
  // ─── execution ─────────────────────────────────────────────────────
  | "TOOL_EXECUTION_FAILED"
  | "AGENT_EXECUTION_FAILED"
  | "CODE_EXECUTION_FAILED"
  | "OUTPUT_SCHEMA_MISMATCH"
  | "REF_UNRESOLVED"
  | "PYTHON_RUNTIME_ERROR"
  | "SQL_SYNTAX_ERROR"
  | "SQL_PERMISSION_DENIED"
  | "HTTP_REQUEST_FAILED"
  | "NODE_TIMEOUT"
  | "WORKFLOW_TIMEOUT"
  | "OUTPUT_REF_UNRESOLVED"
  // ─── workflow-level ────────────────────────────────────────────────
  | "BUDGET_EXCEEDED"
  | "UNKNOWN_ERROR";

/**
 * Codes that describe a failure with no single node to blame. For
 * these, `nodeId` is omitted from the error envelope. For every
 * OTHER code, `nodeId` must be set.
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
 * Engine-internal throwable. See docs/workflow.md for the full
 * contract.
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
  /** Required for node-scoped codes; omitted for {@link WORKFLOW_SCOPED_ERROR_CODES}. */
  readonly nodeId?: number;
  /** Derived at throw time from `spec.nodes[nodeId].tool` or `.agent`
   *  so a stored error stays self-contained if the spec is later
   *  rewritten. */
  readonly nodeName?: string;

  constructor(input: {
    errorCode: WorkflowErrorCode;
    message: string;
    nodeId?: number;
    nodeName?: string;
    cause?: unknown;
  }) {
    // ES2022 native `cause` chain — intentionally NOT serialized into
    // the wire envelope by `toResult()` (engine-side diagnostic only).
    super(input.message, { cause: input.cause });
    this.name = "WorkflowError";
    this.errorCode = input.errorCode;
    this.nodeId = input.nodeId;
    this.nodeName = input.nodeName;
  }
}

/**
 * Plain-object shape consumed by everything outside the engine.
 * `error` is the wire-field name (defineTool tool-return convention);
 * value is the same as the class's `errorCode`.
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
 * Called once at each engine top-level catch boundary.
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
