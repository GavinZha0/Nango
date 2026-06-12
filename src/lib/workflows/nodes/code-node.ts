/**
 * Code-node executor — pure data in / data out.
 *
 * Per-attempt body (retry loop + event emission lives in
 * `with-retries.ts`):
 *   1. Validate `inputs.code_file` path (no absolute paths, no `..`
 *      traversal).
 *   2. Resolve `@path` refs in `inputs.datasets` + `inputs.params`.
 *      `inputs.code_text` is opaque to the resolver.
 *   3. Coerce datasets to `string[]`; serialize params as JSON into
 *      `env[SANDBOX_PARAMS_ENV_KEY]`.
 *   4. Call `deps.runCode({...})` — DI bridge wired to
 *      `getActiveAdapter().run(...)`.
 *   5. Call assembleCodeOutput(result) to build a fixed CodeOutputEnvelope.
 *   6. `ok=false` → throw `CODE_EXECUTION_FAILED` with envelope.error.
 *   7. Return the full CodeOutputEnvelope as the node's output bag.
 *      Downstream nodes ref `@nodes.X.rows`, `@nodes.X.message`, etc.
 */

import { WorkflowError } from "../error";
import type { CanonicalCodeNode } from "../spec/schema";
import { resolveRefs, type ExecutionState } from "../engine/execution-context";
import type { WorkflowEngineDependencies } from "../engine";
import { SANDBOX_PARAMS_ENV_KEY } from "../../sandbox/types";
import { assembleCodeOutput } from "../../sandbox/code-output";
import { withRetries } from "./with-retries";

export type CodeNodeDeps = Pick<
  WorkflowEngineDependencies,
  "runCode" | "emitEvent"
>;

/**
 * Engine-side default for code-node timeout when the spec omits one.
 */
const DEFAULT_CODE_TIMEOUT_SECONDS = 30;

/**
 * Execute one code node. Returns a CodeOutputEnvelope on success;
 * throws `WorkflowError` on the final failure after all retries are
 * exhausted.
 */
export async function executeCodeNode(
  node: CanonicalCodeNode,
  state: ExecutionState,
  deps: CodeNodeDeps,
): Promise<Record<string, unknown>> {
  const displayName = `code:${node.inputs.language}`;
  return withRetries({
    node,
    nodeName: displayName,
    state,
    deps,
    attemptFn: async () => {
      if (node.inputs.code_file !== undefined) {
        validateCodeFilePath(node.inputs.code_file, node.id, displayName);
      }
      if (node.inputs.code_text === undefined && node.inputs.code_file === undefined) {
        throw new WorkflowError({
          errorCode: "SPEC_SCHEMA_MISMATCH",
          message: `Node ${node.id}: code node has neither 'inputs.code_text' nor 'inputs.code_file'.`,
          nodeId: node.id,
          nodeName: displayName,
        });
      }

      const source: { code: string } | { codeFile: string } =
        node.inputs.code_text !== undefined
          ? { code: node.inputs.code_text }
          : { codeFile: node.inputs.code_file! };

      const datasets = coerceDatasets(
        node.inputs.datasets === undefined
          ? undefined
          : resolveRefs(node.inputs.datasets, state),
        node.id,
      );
      const env = buildParamsEnv(
        node.inputs.params === undefined
          ? undefined
          : (resolveRefs(node.inputs.params, state) as Record<string, unknown>),
        node.id,
      );

      const timeoutSeconds = node.timeout_seconds ?? DEFAULT_CODE_TIMEOUT_SECONDS;

      const result = await deps.runCode({
        language: node.inputs.language,
        ...source,
        datasets,
        env,
        timeoutMs: timeoutSeconds * 1000,
        abortSignal: state.abortSignal,
      });

      const envelope = assembleCodeOutput(result);

      if (!envelope.ok) {
        throw new WorkflowError({
          errorCode: "CODE_EXECUTION_FAILED",
          message:
            `Node ${node.id}: code execution failed.` +
            (envelope.error ? `\n${envelope.error}` : ""),
          nodeId: node.id,
          nodeName: displayName,
        });
      }

      return envelope as unknown as Record<string, unknown>;
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

function coerceDatasets(raw: unknown, nodeId: number): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new WorkflowError({
      errorCode: "SPEC_SCHEMA_MISMATCH",
      message: `Node ${nodeId}: code inputs.datasets must be an array, got ${typeof raw}.`,
      nodeId,
    });
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (typeof v !== "string") {
      throw new WorkflowError({
        errorCode: "SPEC_SCHEMA_MISMATCH",
        message: `Node ${nodeId}: code inputs.datasets[${i}] must be a string, got ${typeof v}.`,
        nodeId,
      });
    }
    out.push(v);
  }
  return out;
}

function buildParamsEnv(
  raw: Record<string, unknown> | undefined,
  nodeId: number,
): Record<string, string> {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkflowError({
      errorCode: "SPEC_SCHEMA_MISMATCH",
      message: `Node ${nodeId}: code inputs.params must be an object, got ${describeShape(raw)}.`,
      nodeId,
    });
  }
  if (Object.keys(raw).length === 0) return {};
  return { [SANDBOX_PARAMS_ENV_KEY]: JSON.stringify(raw) };
}

function validateCodeFilePath(
  codeFile: string,
  nodeId: number,
  nodeName: string,
): void {
  if (codeFile.startsWith("/") || codeFile.includes("..")) {
    throw new WorkflowError({
      errorCode: "SPEC_SCHEMA_MISMATCH",
      message:
        `Node ${nodeId}: 'inputs.code_file' must be a relative path with no ` +
        `'..' segments; got: ${JSON.stringify(codeFile)}.`,
      nodeId,
      nodeName,
    });
  }
}

function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
