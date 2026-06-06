/**
 * Chart-node executor — merges an option TEMPLATE with upstream
 * data into a single complete option JSON ready for
 * `<EChartsRenderer />` on the frontend.
 *
 * The node's `inputs.config` carries the renderer-specific option
 * template (today: ECharts) with no data values. `inputs.dataset`
 * is a `@path` ref (or array of refs) into upstream rows. The
 * engine:
 *
 *   1. Resolves the ref(s).
 *   2. Deep-clones the config template.
 *   3. Injects the resolved rows into the renderer's data-binding
 *      slot — for ECharts this is `option.dataset.source`. For a
 *      multi-dataset chart it becomes `option.dataset` as an array
 *      of `{ source }` entries.
 *   4. Returns `{ option: <merged config> }`.
 *
 * There is no external tool call here — the node is a pure
 * deterministic transform. Retries / abort signal handling are
 * therefore omitted: a chart node either succeeds or surfaces a
 * schema mismatch on the first try.
 *
 * Frontend rendering of the merged option still happens in the
 * browser; the engine never produces pixels.
 *
 * See docs/workflow-spec.md (chart node section).
 */

import { WorkflowError } from "../error";
import type { CanonicalChartNode } from "../spec/schema";
import {
  resolveRefs,
  type ExecutionState,
} from "../engine/execution-context";

/** Output bag — single key `option`. See `CHART_NODE_OUTPUTS`. */
interface ChartNodeOutputs extends Record<string, unknown> {
  option: Record<string, unknown>;
}

/**
 * Execute one chart node. Synchronous in shape (returns a Promise
 * for engine-dispatch parity with other nodes).
 */
export async function executeChartNode(
  node: CanonicalChartNode,
  state: ExecutionState,
): Promise<ChartNodeOutputs> {
  const merged = mergeRendererConfig(node, state);
  return { option: merged };
}

/**
 * Renderer-specific merge entry point. `inputs.renderer` is an
 * enum; today only `"echarts"` is supported. New renderers register
 * here.
 */
function mergeRendererConfig(
  node: CanonicalChartNode,
  state: ExecutionState,
): Record<string, unknown> {
  switch (node.inputs.renderer) {
    case "echarts":
      return mergeEchartsConfig(node, state);
  }
}

/**
 * ECharts merge — injects resolved rows into `dataset.source`.
 *
 * Single-dataset case:
 *   config.dataset = { ...existingDataset, source: resolvedRows }
 *
 * Multi-dataset case (inputs.dataset is an array of refs):
 *   config.dataset = refs.map((ref, i) => ({
 *     ...(existingArray?.[i] ?? {}),
 *     source: resolvedRows[i],
 *   }))
 *
 * The merge preserves any `dimensions` / `sourceHeader` /
 * `transform` keys the LLM put on `dataset`; only the `source`
 * slot is overwritten.
 */
function mergeEchartsConfig(
  node: CanonicalChartNode,
  state: ExecutionState,
): Record<string, unknown> {
  const merged = structuredClone(node.inputs.config) as Record<string, unknown>;
  const refValue = node.inputs.dataset;

  // Not-refreshable fallback: no upstream ref, data is already
  // baked into `config.dataset.source` (or wherever the LLM put
  // it at chat time). Return the clone unchanged.
  if (refValue === undefined) {
    return merged;
  }

  if (Array.isArray(refValue)) {
    const resolved = refValue.map((r) => resolveRowsRef(node.id, r, state));
    const existing = Array.isArray(merged.dataset)
      ? (merged.dataset as Array<Record<string, unknown>>)
      : [];
    merged.dataset = resolved.map((source, i) => ({
      ...(existing[i] ?? {}),
      source,
    }));
    return merged;
  }

  const resolved = resolveRowsRef(node.id, refValue, state);
  const existingSingle =
    merged.dataset !== undefined &&
    merged.dataset !== null &&
    typeof merged.dataset === "object" &&
    !Array.isArray(merged.dataset)
      ? (merged.dataset as Record<string, unknown>)
      : {};
  merged.dataset = { ...existingSingle, source: resolved };
  return merged;
}

/**
 * Resolve a single dataset ref string into the upstream array of
 * rows. Throws `CHART_DATASET_REF_INVALID` if the ref does not
 * resolve to a JSON array (ECharts `dataset.source` accepts arrays
 * of arrays OR arrays of objects; either shape passes here).
 */
function resolveRowsRef(
  nodeId: number,
  refStr: string,
  state: ExecutionState,
): unknown {
  const resolved: unknown = resolveRefs(refStr, state);
  if (!Array.isArray(resolved)) {
    throw new WorkflowError({
      errorCode: "REF_UNRESOLVED",
      message:
        `Node ${nodeId} (chart): ref ${JSON.stringify(refStr)} ` +
        `must resolve to an array of rows; got ${typeof resolved}.`,
      nodeId,
    });
  }
  return resolved;
}
