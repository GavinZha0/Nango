/**
 * Unit tests for the chart-node executor.
 *
 * The executor is a pure deterministic merge wrapped in `withRetries`
 * for event-emission consistency. Cases covered:
 *
 *   1. Single dataset ref → merged into `option.dataset.source`.
 *   2. Existing `dataset.dimensions` (or other keys) preserved
 *      verbatim — only `source` is filled.
 *   3. Multi-dataset (refs[] of length ≥ 2) → array of
 *      `{ ...existing[i], source: rows[i] }`.
 *   4. Non-array resolution → `CHART_DATASET_TYPE_MISMATCH`.
 *   5. The original `inputs.config` reference is not mutated
 *      (deep clone) — re-running the same node twice produces the
 *      same shape.
 *   6. `withRetries` emits `workflow_node_attempt_started` and
 *      `workflow_node_completed` events via the injected `deps`.
 */

import { describe, expect, it, vi } from "vitest";

import { WorkflowError } from "@/lib/workflows/error";
import type { ExecuteParams } from "@/lib/workflows/engine";
import {
  createExecutionState,
  type ExecutionState,
} from "@/lib/workflows/engine/execution-context";
import {
  executeChartNode,
  type ChartNodeDeps,
} from "@/lib/workflows/nodes/chart-node";
import type {
  CanonicalChartNode,
  CanonicalWorkflowSpec,
} from "@/lib/workflows/spec/schema";

// ─── Fixtures ─────────────────────────────────────────────────────────

function makeDeps(): ChartNodeDeps {
  return { emitEvent: vi.fn() };
}

function chartNode(
  overrides?: Partial<Omit<CanonicalChartNode, "type">>,
): CanonicalChartNode {
  return {
    type: "chart",
    schema_version: "1",
    id: 1,
    description: "bar chart",
    depends_on: [0],
    inputs: {
      renderer: "echarts",
      config: {
        xAxis: { type: "category" },
        yAxis: { type: "value" },
        series: [
          { type: "bar", encode: { x: "month", y: "sales" } },
        ],
      },
      dataset: "@nodes.0.rows",
    },
    ...overrides,
  };
}

function makeState(
  node: CanonicalChartNode,
  upstreamOutputs: Map<number, Record<string, unknown>>,
): ExecutionState {
  const spec: CanonicalWorkflowSpec = {
    name: "demo",
    nodes: [
      {
        type: "sql",
        schema_version: "1",
        id: 0,
        description: "upstream sql",
        depends_on: [],
        inputs: {
          data_source_name: "src",
          data_source_id: "11111111-1111-4111-8111-111111111111",
          sql_text: "SELECT month, sales FROM orders",
        },
      },
      node,
    ],
    outputs: { option: "@nodes.1.option" },
  };
  const params: ExecuteParams = {
    workflowId: "wf-1",
    runId: "run-1",
    spec,
    input: {},
    context: {},
    abortController: new AbortController(),
  };
  const state = createExecutionState(params);
  for (const [id, out] of upstreamOutputs) state.outputs.set(id, out);
  return state;
}

const ROWS = [
  { month: "2026-01", sales: 12500 },
  { month: "2026-02", sales: 13200 },
];

// ─── Tests ────────────────────────────────────────────────────────────

describe("executeChartNode — single dataset", () => {
  it("merges resolved rows into option.dataset.source", async () => {
    const node = chartNode();
    const state = makeState(node, new Map([[0, { rows: ROWS }]]));
    const out = await executeChartNode(node, state, makeDeps());
    expect(out.option.dataset).toEqual({ source: ROWS });
  });

  it("preserves existing dataset keys (dimensions, etc.) — only source is filled", async () => {
    const node = chartNode({
      inputs: {
        renderer: "echarts",
        config: {
          dataset: { dimensions: ["month", "sales"] },
          xAxis: { type: "category" },
          yAxis: { type: "value" },
          series: [{ type: "bar" }],
        },
        dataset: "@nodes.0.rows",
      },
    });
    const state = makeState(node, new Map([[0, { rows: ROWS }]]));
    const out = await executeChartNode(node, state, makeDeps());
    expect(out.option.dataset).toEqual({
      dimensions: ["month", "sales"],
      source: ROWS,
    });
  });

  it("does NOT mutate the original node.inputs.config (deep clone)", async () => {
    const node = chartNode();
    const beforeStr = JSON.stringify(node.inputs.config);
    const state = makeState(node, new Map([[0, { rows: ROWS }]]));
    await executeChartNode(node, state, makeDeps());
    expect(JSON.stringify(node.inputs.config)).toBe(beforeStr);
  });

  it("running twice produces equal output (deterministic)", async () => {
    const node = chartNode();
    const state = makeState(node, new Map([[0, { rows: ROWS }]]));
    const a = await executeChartNode(node, state, makeDeps());
    const b = await executeChartNode(node, state, makeDeps());
    expect(a).toEqual(b);
  });

  it("preserves non-dataset config keys (xAxis, yAxis, series, …)", async () => {
    const node = chartNode();
    const state = makeState(node, new Map([[0, { rows: ROWS }]]));
    const out = await executeChartNode(node, state, makeDeps());
    expect(out.option.xAxis).toEqual({ type: "category" });
    expect(out.option.yAxis).toEqual({ type: "value" });
    expect(out.option.series).toEqual([
      { type: "bar", encode: { x: "month", y: "sales" } },
    ]);
  });
});

describe("executeChartNode — multi-dataset", () => {
  it("builds an array of {source} entries per ref", async () => {
    const node = chartNode({
      inputs: {
        renderer: "echarts",
        config: {
          series: [
            { type: "line", datasetIndex: 0 },
            { type: "line", datasetIndex: 1 },
          ],
        },
        dataset: ["@nodes.0.rows", "@nodes.0.rows"],
      },
    });
    const state = makeState(node, new Map([[0, { rows: ROWS }]]));
    const out = await executeChartNode(node, state, makeDeps());
    expect(out.option.dataset).toEqual([
      { source: ROWS },
      { source: ROWS },
    ]);
  });

  it("preserves per-dataset config entries when LLM pre-populated them", async () => {
    const node = chartNode({
      inputs: {
        renderer: "echarts",
        config: {
          dataset: [
            { dimensions: ["month", "sales"] },
            { dimensions: ["month", "profit"] },
          ],
          series: [
            { type: "line", datasetIndex: 0 },
            { type: "line", datasetIndex: 1 },
          ],
        },
        dataset: ["@nodes.0.rows", "@nodes.0.rows"],
      },
    });
    const state = makeState(node, new Map([[0, { rows: ROWS }]]));
    const out = await executeChartNode(node, state, makeDeps());
    expect(out.option.dataset).toEqual([
      { dimensions: ["month", "sales"], source: ROWS },
      { dimensions: ["month", "profit"], source: ROWS },
    ]);
  });
});

describe("executeChartNode — D39.C not-refreshable fallback", () => {
  it("passes config through verbatim when inputs.dataset is absent", async () => {
    const inlineRows = [
      { month: "fictional-01", sales: 999 },
      { month: "fictional-02", sales: 1234 },
    ];
    const node = chartNode({
      inputs: {
        renderer: "echarts",
        config: {
          xAxis: { type: "category" },
          yAxis: { type: "value" },
          series: [{ type: "bar" }],
          dataset: { source: inlineRows },
        },
        // dataset omitted on purpose — the not-refreshable case
      },
      depends_on: [],
    });
    const state = makeState(node, new Map());
    const out = await executeChartNode(node, state, makeDeps());
    expect(out.option.dataset).toEqual({ source: inlineRows });
  });

  it("does not mutate inputs.config when dataset is absent", async () => {
    const inlineRows = [{ a: 1 }];
    const node = chartNode({
      inputs: {
        renderer: "echarts",
        config: {
          series: [{ type: "pie" }],
          dataset: { source: inlineRows },
        },
      },
      depends_on: [],
    });
    const state = makeState(node, new Map());
    const before = JSON.stringify(node.inputs.config);
    await executeChartNode(node, state, makeDeps());
    expect(JSON.stringify(node.inputs.config)).toBe(before);
  });
});

describe("executeChartNode — failure modes", () => {
  it("throws CHART_DATASET_TYPE_MISMATCH when upstream resolves to a non-array value", async () => {
    const node = chartNode({
      inputs: {
        renderer: "echarts",
        config: { series: [{ type: "bar" }] },
        dataset: "@nodes.0.name",
      },
    });
    const state = makeState(
      node,
      new Map([[0, { name: "not_an_array_value", rows: ROWS }]]),
    );
    await expect(executeChartNode(node, state, makeDeps())).rejects.toThrow(
      WorkflowError,
    );
    await expect(
      executeChartNode(node, state, makeDeps()),
    ).rejects.toMatchObject({
      errorCode: "CHART_DATASET_TYPE_MISMATCH",
      nodeId: 1,
    });
  });
});

describe("executeChartNode — event emission (C1)", () => {
  it("emits workflow_node_attempt_started and workflow_node_completed on success", async () => {
    const node = chartNode();
    const state = makeState(node, new Map([[0, { rows: ROWS }]]));
    const deps = makeDeps();
    await executeChartNode(node, state, deps);

    const emitted = (deps.emitEvent as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as { type: string }).type,
    );
    expect(emitted).toContain("workflow_node_attempt_started");
    expect(emitted).toContain("workflow_node_completed");
  });

  it("emits workflow_node_attempt_started and workflow_node_attempt_failed on error", async () => {
    const node = chartNode({
      inputs: {
        renderer: "echarts",
        config: { series: [{ type: "bar" }] },
        dataset: "@nodes.0.name",
      },
    });
    const state = makeState(
      node,
      new Map([[0, { name: "scalar_not_array", rows: ROWS }]]),
    );
    const deps = makeDeps();
    await expect(executeChartNode(node, state, deps)).rejects.toThrow(
      WorkflowError,
    );

    const emitted = (deps.emitEvent as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as { type: string }).type,
    );
    expect(emitted).toContain("workflow_node_attempt_started");
    expect(emitted).toContain("workflow_node_attempt_failed");
  });
});
