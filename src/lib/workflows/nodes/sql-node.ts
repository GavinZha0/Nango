/**
 * SQL-node executor (D36) — bridges to the existing
 * `extract_dataset_by_sql` server-side tool.
 *
 * Per-attempt body (retry loop + event emission lives in
 * `with-retries.ts`):
 *
 *   1. Resolve `@path` refs in `node.query`, `node.dataSourceName`,
 *      `node.name` — these are the three string fields that can
 *      carry refs into the SQL invocation.
 *   2. Look up the `extract_dataset_by_sql` tool handle via the
 *      injected `deps.getTool(...)`. The handle is shared with the
 *      generic tool-node path — no separate engine-side adapter.
 *   3. Compose the tool input from the resolved fields + the
 *      workflow-fixed defaults (`previewRows: 0` — workflow data
 *      flow doesn't consume inline previews; `forceRefresh: false`
 *      — workflow-scoped refresh happens at the artifact level).
 *   4. Call `tool.execute(...)` and inspect the result envelope:
 *        - `{ ok: false, error: { code, message } }` →
 *          translate `error.code` into a `WorkflowErrorCode` and
 *          throw.
 *        - Success → strip the operational fields (cacheHit /
 *          ttlHours / schema / preview) and return just
 *          `{ name, rowCount }` to match `DEFAULT_SQL_NODE_OUTPUTS`.
 *
 * Failures throw — `withRetries` exhausts attempts before giving
 * up.
 *
 * See `docs/workflow-architecture.md` §17.26 (D36) for the design
 * rationale; the tool itself lives in
 * `src/lib/data-sources/runtime-tools.ts`.
 */

import { WorkflowError } from "../error";
import type { WorkflowErrorCode } from "../error";
import type { CanonicalSqlNode } from "../spec/schema";
import {
  resolveRefs,
  type ExecutionState,
} from "../engine/execution-context";
import type { WorkflowEngineDependencies } from "../engine";
import { withRetries } from "./with-retries";

export type SqlNodeDeps = Pick<
  WorkflowEngineDependencies,
  "getTool" | "emitEvent"
>;

/**
 * Tool name the engine reaches for to actually run the SQL.
 * Constant here (not configurable) — the SQL node is by
 * definition a wrapper around this specific server tool. If the
 * tool isn't in the user catalog, the workflow can't execute SQL
 * nodes (caller's responsibility to make sure the artifact's
 * owner has at least one data source binding so the tool is
 * auto-mounted).
 */
const SQL_TOOL_NAME = "extract_dataset_by_sql";

/**
 * Execute one SQL node. Returns the node's outputs bag on
 * success; throws `WorkflowError` on the final failure after all
 * retries are exhausted.
 */
export async function executeSqlNode(
  node: CanonicalSqlNode,
  state: ExecutionState,
  deps: SqlNodeDeps,
): Promise<Record<string, unknown>> {
  const displayName = `sql:${node.dataSourceName}`;
  return withRetries({
    node,
    nodeName: displayName,
    state,
    deps,
    attemptFn: async () => {
      // Resolve refs in each ref-bearing string field individually.
      // resolveRefs returns the resolved value typed as `unknown`,
      // so we narrow before handing to the tool.
      const dataSourceName = resolveStringField(
        resolveRefs(node.dataSourceName, state),
        node.id,
        "dataSourceName",
      );
      const query = resolveStringField(
        resolveRefs(node.query, state),
        node.id,
        "query",
      );
      const name =
        node.name !== undefined
          ? resolveStringField(
              resolveRefs(node.name, state),
              node.id,
              "name",
            )
          : deriveDefaultDatasetName(state.runId, node.id);

      const tool = deps.getTool(SQL_TOOL_NAME);
      if (tool === null) {
        throw new WorkflowError({
          errorCode: "TOOL_NOT_FOUND",
          message:
            `Node ${node.id}: SQL execution requires the '${SQL_TOOL_NAME}' ` +
            "tool, which is not in the workflow runner's catalog. The " +
            "artifact's owner needs at least one enabled data source " +
            "binding for this tool to be auto-mounted.",
          nodeId: node.id,
          nodeName: displayName,
        });
      }

      const rawResult = await tool.execute({
        input: {
          name,
          dataSourceName,
          query,
          // Workflow data flow doesn't consume inline previews;
          // skip the read & response payload.
          previewRows: 0,
          // Workflow-scoped refresh happens at the artifact level
          // (via POST /api/artifacts/[id]/refresh's L2 cache
          // bypass), not per-node.
          forceRefresh: false,
        },
        abortSignal: state.abortSignal,
        context: state.context,
      });

      // The tool returns either `{ ok: false, error: {...} }` on
      // failure or the success blob directly (no `ok: true`
      // wrapper).
      if (isFailedResult(rawResult)) {
        const errorCode = mapToolErrorCodeToWorkflowCode(rawResult.error.code);
        throw new WorkflowError({
          errorCode,
          message:
            `Node ${node.id}: ${SQL_TOOL_NAME} failed ` +
            `(${rawResult.error.code}): ${rawResult.error.message}`,
          nodeId: node.id,
          nodeName: displayName,
        });
      }

      // Defensive shape check — the tool's success envelope
      // should always be an object carrying { name, rowCount, ... }.
      // A non-object response indicates a tool-side contract
      // violation that we surface as TOOL_EXECUTION_FAILED.
      if (
        rawResult === null ||
        typeof rawResult !== "object" ||
        Array.isArray(rawResult)
      ) {
        throw new WorkflowError({
          errorCode: "TOOL_EXECUTION_FAILED",
          message:
            `Node ${node.id}: ${SQL_TOOL_NAME} returned a non-object ` +
            `result (got ${typeof rawResult}); expected ` +
            "{ name, rowCount, ... }.",
          nodeId: node.id,
          nodeName: displayName,
        });
      }
      const result = rawResult as Record<string, unknown>;
      const outputName = readString(result, "name") ?? name;
      const rowCount = readNumber(result, "rowCount") ?? 0;

      // Strip the tool's operational metadata (cacheHit, ttlHours,
      // schema, preview) — only `name` + `rowCount` are part of
      // the SQL node's downstream-referenceable contract. Admin
      // forensics still has the full tool result via the engine
      // event log (workflow_node_completed.outputs includes the
      // raw tool envelope for tool nodes; for SQL it's stripped
      // here on purpose).
      return {
        name: outputName,
        rowCount,
      };
    },
    wrapError: (err) => {
      if (err instanceof WorkflowError) return err;
      return new WorkflowError({
        errorCode: "TOOL_EXECUTION_FAILED",
        message: err instanceof Error ? err.message : String(err),
        nodeId: node.id,
        nodeName: displayName,
        cause: err,
      });
    },
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────

/** Failed-result envelope shape from `extract_dataset_by_sql`. */
interface FailedToolResult {
  ok: false;
  error: { code: string; message: string };
}

function isFailedResult(value: unknown): value is FailedToolResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (v.ok !== false) return false;
  const err = v.error;
  if (err === null || typeof err !== "object" || Array.isArray(err)) {
    return false;
  }
  const e = err as Record<string, unknown>;
  return typeof e.code === "string" && typeof e.message === "string";
}

/**
 * Translate `extract_dataset_by_sql` error envelope codes to the
 * engine's `WorkflowErrorCode` taxonomy. Unknown codes fall back
 * to TOOL_EXECUTION_FAILED so the engine never throws an unknown
 * error class.
 *
 * The tool's error codes (see `src/lib/data-sources/runtime-tools.ts`
 * + `data-sources/policy.ts` + `data-sources/lookup.ts`):
 *
 *   - INVALID_NAME / QUERY_HASH_MISMATCH  → TOOL_INPUT_SCHEMA_MISMATCH
 *   - DATA_SOURCE_NOT_FOUND / DISABLED    → TOOL_NOT_FOUND
 *   - POLICY_VIOLATION / WRITES_DISALLOWED
 *     / TABLE_DENIED / TABLE_NOT_ALLOWED  → SQL_PERMISSION_DENIED
 *   - PARSE_ERROR / SQL_SYNTAX_ERROR      → SQL_SYNTAX_ERROR
 *   - EXTRACT_FAILED / *                  → TOOL_EXECUTION_FAILED
 *
 * NOTE: `QUERY_HASH_MISMATCH` is no longer emitted at runtime — the
 * tool switched to slot-reassignment semantics (see `data-sources.md`
 * §4.2). The case is kept as defensive code so any legacy persisted
 * workflow event referencing it still maps cleanly instead of falling
 * through to TOOL_EXECUTION_FAILED.
 */
function mapToolErrorCodeToWorkflowCode(code: string): WorkflowErrorCode {
  switch (code) {
    case "INVALID_NAME":
    case "QUERY_HASH_MISMATCH":
      return "TOOL_INPUT_SCHEMA_MISMATCH";
    case "DATA_SOURCE_NOT_FOUND":
    case "DATA_SOURCE_DISABLED":
      return "TOOL_NOT_FOUND";
    case "POLICY_VIOLATION":
    case "WRITES_DISALLOWED":
    case "TABLE_DENIED":
    case "TABLE_NOT_ALLOWED":
      return "SQL_PERMISSION_DENIED";
    case "PARSE_ERROR":
    case "SQL_SYNTAX_ERROR":
      return "SQL_SYNTAX_ERROR";
    default:
      return "TOOL_EXECUTION_FAILED";
  }
}

/**
 * Narrow a resolved-ref value to a string. The engine guarantees
 * `resolveRefs(<literal-string>, state)` returns the same string
 * when no refs are embedded, and a string when the value is a
 * pure-ref-string-typed @workflow.foo bound to a string. If we
 * ever see a non-string here, the spec is malformed — surface as
 * SPEC_SCHEMA_MISMATCH so the failure is actionable.
 */
function resolveStringField(
  value: unknown,
  nodeId: number,
  fieldName: string,
): string {
  if (typeof value !== "string") {
    throw new WorkflowError({
      errorCode: "SPEC_SCHEMA_MISMATCH",
      message:
        `Node ${nodeId}: sql.${fieldName} must resolve to a string ` +
        `(got ${typeof value}). Check that any refs in the field ` +
        "point to string-typed upstream outputs.",
      nodeId,
    });
  }
  return value;
}

/**
 * Stable fallback dataset slug when the spec omits `node.name`.
 * Format: `wf_<runId-first-8>_n<nodeId>` — deterministic per run
 * so repeat refresh runs hit the same cache slot. Cap length at
 * 64 chars to stay within the dataset-name regex bounds (see
 * `data-sources/cache.ts::validateDatasetName`).
 */
function deriveDefaultDatasetName(runId: string, nodeId: number): string {
  const prefix = runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "run";
  return `wf_${prefix}_n${nodeId}`.slice(0, 64);
}

function readString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function readNumber(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
