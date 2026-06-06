/**
 * Code-node executor — pure data in / data out.
 *
 * Per-attempt body (retry loop + event emission lives in
 * `with-retries.ts`):
 *   1. Resolve `@path` refs in `node.inputs` (datasets, env, …).
 *   2. Coerce conventional input keys into the sandbox dispatch shape
 *      — `inputs.datasets` and `inputs.env`.
 *   3. Call `deps.runCode({...})` — DI bridge wired to
 *      `getActiveAdapter().run(...)`.
 *   4. `exitCode !== 0` → throw `CODE_EXECUTION_FAILED` with stderr
 *      surfaced.
 *   5. With `output_schema`: `JSON.parse(stdout)`, validate, expose
 *      parsed object's top-level keys. Without: expose the fixed
 *      envelope `{ stdout, stderr, exitCode, durationMs }`.
 */

import { WorkflowError } from "../error";
import type { CanonicalCodeNode } from "../spec/schema";
import { resolveRefs, type ExecutionState } from "../engine/execution-context";
import type { WorkflowEngineDependencies } from "../engine";
import {
  formatValidationErrors,
  validateAgainstSchema,
} from "./schema-validator";
import { withRetries } from "./with-retries";

export type CodeNodeDeps = Pick<
  WorkflowEngineDependencies,
  "runCode" | "emitEvent"
>;

/**
 * Engine-side default for code-node timeout when the spec omits one.
 * Mirrors the per-tool default in the sandbox adapter. Operator-
 * tunable via `workflow.execution.default_timeout` — keep this
 * constant in sync with that config key's default seed.
 */
const DEFAULT_CODE_TIMEOUT_SECONDS = 30;

/**
 * Execute one code node. Returns the node's outputs bag on success;
 * throws `WorkflowError` on the final failure after all retries are
 * exhausted.
 */
export async function executeCodeNode(
  node: CanonicalCodeNode,
  state: ExecutionState,
  deps: CodeNodeDeps,
): Promise<Record<string, unknown>> {
  const displayName = `code:${node.language}`;
  return withRetries({
    node,
    nodeName: displayName,
    state,
    deps,
    attemptFn: async () => {
      // resolveRefs walks arrays per-element so dataset refs
      // produced by Strategy Z+ become literal strings for the
      // sandbox call.
      const resolvedInput = resolveRefs(node.inputs ?? {}, state) as Record<
        string,
        unknown
      >;
      const datasets = coerceDatasets(resolvedInput, node.id);
      const env = coerceEnv(resolvedInput, node.id);

      const timeoutSeconds = node.timeout_seconds ?? DEFAULT_CODE_TIMEOUT_SECONDS;

      const result = await deps.runCode({
        language: node.language,
        code: node.code,
        datasets,
        env,
        timeoutMs: timeoutSeconds * 1000,
        abortSignal: state.abortSignal,
      });

      // Surface stderr in the error message so admin run forensics
      // shows the Python traceback without expanding the result blob.
      if (result.exitCode !== 0) {
        const trimmed = result.stderr.trim().slice(0, 4000);
        throw new WorkflowError({
          errorCode: "CODE_EXECUTION_FAILED",
          message:
            `Node ${node.id}: code execution failed with exitCode=${result.exitCode}` +
            (trimmed.length > 0 ? `\nstderr: ${trimmed}` : ""),
          nodeId: node.id,
          nodeName: displayName,
        });
      }

      // No declared schema → return the fixed envelope shape so
      // downstream nodes can ref `@nodes.X.stdout`, etc.
      if (node.output_schema === undefined) {
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch (err) {
        throw new WorkflowError({
          errorCode: "OUTPUT_SCHEMA_MISMATCH",
          message:
            `Node ${node.id}: code declared output_schema but stdout is not valid JSON ` +
            `(${err instanceof Error ? err.message : String(err)}).`,
          nodeId: node.id,
          nodeName: displayName,
        });
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new WorkflowError({
          errorCode: "OUTPUT_SCHEMA_MISMATCH",
          message:
            `Node ${node.id}: code stdout JSON must be an object (got ${describeShape(parsed)}).`,
          nodeId: node.id,
          nodeName: displayName,
        });
      }
      const outputs = parsed as Record<string, unknown>;
      const validation = validateAgainstSchema(node.output_schema, outputs);
      if (!validation.ok) {
        throw new WorkflowError({
          errorCode: "OUTPUT_SCHEMA_MISMATCH",
          message: `Node ${node.id}: code stdout failed output_schema — ${formatValidationErrors(validation.errors)}`,
          nodeId: node.id,
          nodeName: displayName,
        });
      }
      return outputs;
    },
    wrapError: (err) => {
      if (err instanceof WorkflowError) return err;
      return new WorkflowError({
        errorCode: "CODE_EXECUTION_FAILED",
        message: err instanceof Error ? err.message : String(err),
        nodeId: node.id,
        nodeName: displayName,
        cause: err,
      });
    },
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Read `inputs.datasets` as `string[]`. Refs in this array were
 * rewritten as concrete strings by the resolveRefs walk; this helper
 * only enforces the array-of-strings shape.
 */
function coerceDatasets(
  input: Record<string, unknown>,
  nodeId: number,
): string[] {
  const raw = input.datasets;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new WorkflowError({
      errorCode: "SPEC_SCHEMA_MISMATCH",
      message: `Node ${nodeId}: code input.datasets must be an array, got ${typeof raw}.`,
      nodeId,
    });
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (typeof v !== "string") {
      throw new WorkflowError({
        errorCode: "SPEC_SCHEMA_MISMATCH",
        message: `Node ${nodeId}: code input.datasets[${i}] must be a string, got ${typeof v}.`,
        nodeId,
      });
    }
    out.push(v);
  }
  return out;
}

/**
 * Read `inputs.env` as `Record<string, string>`. Values that resolved
 * to non-strings are coerced — env vars are string-typed at the OS
 * boundary.
 */
function coerceEnv(
  input: Record<string, unknown>,
  nodeId: number,
): Record<string, string> {
  const raw = input.env;
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkflowError({
      errorCode: "SPEC_SCHEMA_MISMATCH",
      message: `Node ${nodeId}: code input.env must be an object, got ${describeShape(raw)}.`,
      nodeId,
    });
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
