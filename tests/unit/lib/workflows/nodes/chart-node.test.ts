/**
 * Unit tests for the chart-node executor.
 *
 * The executor is a pure deterministic merge — no retries, no
 * external tool call. Cases covered:
 *
 *   1. Single dataset ref → merged into `option.dataset.source`.
 *   2. Existing `dataset.dimensions` (or other keys) preserved
 *      verbatim — only `source` is filled.
 *   3. Multi-dataset (refs[] of length ≥ 2) → array of
 *      `{ ...existing[i], source: rows[i] }`.
 *   4. Non-array resolution → `REF_UNRESOLVED`.
 *   5. The original `inputs.config` reference is not mutated
 *      (deep clone) — re-running the same node twice produces the
 *      same shape.
 */

import { describe, expect, it } from "vitest";

import { WorkflowError } from "@/lib/workflows/error";
import type { ExecuteParams } from "@/lib/workflows/engine";
import {
  createExecutionState,
  type ExecutionState,
} from "@/lib/workflows/engine/execution-context";
import { executeChartNode } from "@/lib/workflows/nodes/chart-node";
import type {
  CanonicalChartNode,
  CanonicalWorkflowSpec,
} from "@/lib/workflows/spec/schema";

// ─── Fixtures ─────────────────────────────────────────────────────────

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
    outputs: ["option"],
    ...overrides,
  };
}

function makeState(
  node: CanonicalChartNode,
  upstreamOutputs: Map<number, Record<string, unknown>>,
): ExecutionState {
  const spec: CanonicalWorkflowSpec = {
    version: "1.0",
    name: "demo",
    ref_recon_algorithm: "ref_recon_v1",
    nodes: [
      {
        type: "sql",
        schema_version: "1",
        id: 0,
        description: "upstream sql",
        depends_on: [],
        data_source_name: "src",
        query: "SELECT month, sales FROM orders",
        outputs: ["name", "row_count", "rows"],
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
    const state = makeState(
      node,
      new Map([[0, { rows: ROWS }]]),
    );
    const out = await executeChartNode(node, state);
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
    const state = makeState(
      node,
      new Map([[0, { rows: ROWS }]]),
    );
    const out = await executeChartNode(node, state);
    expect(out.option.dataset).toEqual({
      dimensions: ["month", "sales"],
      source: ROWS,
    });
  });

  it("does NOT mutate the original node.inputs.config (deep clone)", async () => {
    const node = chartNode();
    const beforeStr = JSON.stringify(node.inputs.config);
    const state = makeState(
      node,
      new Map([[0, { rows: ROWS }]]),
    );
    await executeChartNode(node, state);
    expect(JSON.stringify(node.inputs.config)).toBe(beforeStr);
  });

  it("running twice produces equal output (deterministic)", async () => {
    const node = chartNode();
    const state = makeState(
      node,
      new Map([[0, { rows: ROWS }]]),
    );
    const a = await executeChartNode(node, state);
    const b = await executeChartNode(node, state);
    expect(a).toEqual(b);
  });

  it("preserves non-dataset config keys (xAxis, yAxis, series, …)", async () => {
    const node = chartNode();
    const state = makeState(
      node,
      new Map([[0, { rows: ROWS }]]),
    );
    const out = await executeChartNode(node, state);
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
    const state = makeState(
      node,
      new Map([[0, { rows: ROWS }]]),
    );
    const out = await executeChartNode(node, state);
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
    const state = makeState(
      node,
      new Map([[0, { rows: ROWS }]]),
    );
    const out = await executeChartNode(node, state);
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
    const out = await executeChartNode(node, state);
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
    await executeChartNode(node, state);
    expect(JSON.stringify(node.inputs.config)).toBe(before);
  });
});

describe("executeChartNode — failure modes", () => {
  it("throws REF_UNRESOLVED when upstream resolves to a non-array value", async () => {
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
    await expect(executeChartNode(node, state)).rejects.toThrow(
      WorkflowError,
    );
    await expect(executeChartNode(node, state)).rejects.toMatchObject({
      errorCode: "REF_UNRESOLVED",
      nodeId: 1,
    });
  });
});
