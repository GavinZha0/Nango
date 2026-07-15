/**
 * SQL-node executor — bridges to the existing `extract_dataset_by_sql`
 * server-side tool.
 *
 * Per-attempt body (retry loop + event emission lives in
 * `with-retries.ts`):
 *   1. Resolve `@path` refs in `inputs.sql_text`,
 *      `inputs.data_source_name`, `inputs.dataset_name`.
 *   2. Look up the `extract_dataset_by_sql` tool via `deps.getTool`.
 *   3. Compose the tool input with the engine-resolved row cap
 *      (`sql.inline_max_rows`) and `force_refresh: false` — refresh
 *      is an artifact-level concern.
 *   4. Translate the tool's failure envelope into the right
 *      `WorkflowErrorCode`; on success, project the tool's
 *      snake_case fields onto the SQL node's spec output envelope.
 *
 * See docs/workflow.md. The tool itself lives in
 * `src/lib/data-sources/runtime-tools.ts`.
 */

import { getConfigNumber } from "@/lib/config";

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
 * Tool name the engine reaches for to actually run the SQL. If the
 * tool isn't in the user catalog, the workflow can't execute SQL
 * nodes (the artifact's owner needs at least one data source binding
 * for this tool to be auto-mounted).
 */
const SQL_TOOL_NAME = "extract_dataset_by_sql";

/**
 * Default inline-row cap when `sql.inline_max_rows` is not set in
 * the runtime config. The SQL tool's preview hard cap
 * (`datasource.preview.max_rows`) is the upper limit at the tool
 * boundary; the engine policy is bounded by it.
 */
const DEFAULT_SQL_INLINE_MAX_ROWS = 200;

/**
 * Execute one SQL node. Returns the node's outputs bag on success;
 * throws `WorkflowError` on the final failure after all retries are
 * exhausted.
 */
export async function executeSqlNode(
  node: CanonicalSqlNode,
  state: ExecutionState,
  deps: SqlNodeDeps,
): Promise<Record<string, unknown>> {
  const displayName = `sql:${node.inputs.data_source_name}`;
  return withRetries({
    node,
    nodeName: displayName,
    state,
    deps,
    attemptFn: async () => {
      const dataSourceName = resolveStringField(
        resolveRefs(node.inputs.data_source_name, state),
        node.id,
        "data_source_name",
      );
      const sqlText = resolveStringField(
        resolveRefs(node.inputs.sql_text, state),
        node.id,
        "sql_text",
      );
      const datasetName =
        node.inputs.dataset_name !== undefined
          ? resolveStringField(
              resolveRefs(node.inputs.dataset_name, state),
              node.id,
              "dataset_name",
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

      const inlineMaxRows = node.inputs.row_limit ?? getConfigNumber(
        "sql.inline_max_rows",
        DEFAULT_SQL_INLINE_MAX_ROWS,
      );

      const rawResult = await tool.execute({
        input: {
          dataset_name: datasetName,
          data_source_name: dataSourceName,
          sql_text: sqlText,
          row_limit: inlineMaxRows,
          // Refresh happens at the artifact level, not per-node.
          force_refresh: false,
        },
        abortSignal: state.abortSignal,
        context: state.context,
      });

      // Tool returns either `{ ok: false, error: {...} }` on failure
      // or the success blob directly (no `ok: true` wrapper).
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

      // Defensive shape check — a non-object response indicates a
      // tool-side contract violation.
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
            "{ dataset_name, total_rows, rows, ... }.",
          nodeId: node.id,
          nodeName: displayName,
        });
      }
      const result = rawResult as Record<string, unknown>;
      const outDatasetName = readString(result, "dataset_name") ?? datasetName;
      const totalRows = readNumber(result, "total_rows") ?? 0;
      const rows = readArray(result, "rows") ?? [];
      const returnedRows = readNumber(result, "returned_rows") ?? rows.length;
      const rowSchema = readObject(result, "row_schema") ?? { columns: [] };

      // Strip the tool's operational metadata (cache_hit, ttl_hours,
      // replaced_prior) — only the fields in
      // `DEFAULT_SQL_NODE_OUTPUTS` are part of the SQL node's
      // downstream-referenceable contract.
      return {
        dataset_name: outDatasetName,
        total_rows: totalRows,
        returned_rows: returnedRows,
        rows,
        row_schema: rowSchema,
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
 * Translate `extract_dataset_by_sql` error codes to the engine's
 * `WorkflowErrorCode` taxonomy. Unknown codes fall back to
 * TOOL_EXECUTION_FAILED so the engine never throws an unknown class.
 */
function mapToolErrorCodeToWorkflowCode(code: string): WorkflowErrorCode {
  switch (code) {
    case "INVALID_NAME":
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
 * Narrow a resolved-ref value to a string. A non-string here means
 * the spec is malformed — surface as SPEC_SCHEMA_MISMATCH so the
 * failure is actionable.
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
 * Format: `wf_<runId-first-8>_n<nodeId>` — deterministic per run so
 * repeat refresh runs hit the same cache slot. Cap length at 64 to
 * stay within the dataset-name regex bounds.
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

function readArray(
  obj: Record<string, unknown>,
  key: string,
): unknown[] | undefined {
  const v = obj[key];
  return Array.isArray(v) ? v : undefined;
}

function readObject(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const v = obj[key];
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
