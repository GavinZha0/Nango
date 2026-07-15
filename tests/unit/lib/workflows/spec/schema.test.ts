import { describe, expect, it } from "vitest";

import {
  CanonicalWorkflowSpecSchema,
  LLMWorkflowSpecSchema,
  type CanonicalAgentNode,
  type CanonicalToolNode,
  type CanonicalWorkflowSpec,
  type LLMAgentNode,
  type LLMToolNode,
  type LLMWorkflowSpec,
} from "@/lib/workflows/spec/schema";

/**
 * Minimal valid fixtures. The tool / agent nodes are constructed as
 * their specific variants (not the union type) so spread+override
 * in individual tests preserves discriminated-union narrowing.
 */
const toolNode: LLMToolNode = {
  id: 0,
  description: "Fetch Q4 orders",
  depends_on: [],
  type: "tool",  inputs: {
    name: "fetch_data_table",
    arguments: { dataSourceName: "warehouse_prod", sql: "SELECT *" },
  },
};

const agentNode: LLMAgentNode = {
  id: 1,
  description: "Summarise anomalies",
  depends_on: [0],
  type: "agent",
  inputs: {
    name: "Nango Builtin / Data Analyst",
    task: "find anomalies",
    context: "@nodes.0.dataset",
  },
};

const baseLLMSpec: LLMWorkflowSpec = {
  name: "Q4 Sales Analysis",
  nodes: [toolNode, agentNode],
  outputs: { summary: "@nodes.1.result" },
};

const canonicalToolNode: CanonicalToolNode = {
  ...toolNode,
  type: "tool",
  schema_version: "1",
};
const canonicalAgentNode: CanonicalAgentNode = {
  ...agentNode,
  type: "agent",
  schema_version: "1",
  inputs: {
    ...agentNode.inputs,
    agent_id: "550e8400-e29b-41d4-a716-446655440000",
  },
};
const baseCanonicalSpec: CanonicalWorkflowSpec = {
  ...baseLLMSpec,
  nodes: [canonicalToolNode, canonicalAgentNode],
};

describe("LLMWorkflowSpecSchema", () => {
  it("accepts a minimal valid LLM-emit spec", () => {
    const parsed = LLMWorkflowSpecSchema.parse(baseLLMSpec);
    expect(parsed.name).toBe("Q4 Sales Analysis");
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.outputs).toEqual({ summary: "@nodes.1.result" });
  });

  it("requires non-empty nodes[]", () => {
    expect(() =>
      LLMWorkflowSpecSchema.parse({ ...baseLLMSpec, nodes: [] }),
    ).toThrow();
  });

  it("requires non-empty outputs map", () => {
    expect(() =>
      LLMWorkflowSpecSchema.parse({ ...baseLLMSpec, outputs: {} }),
    ).toThrow();
  });

  it("rejects negative node ids (D29 — non-negative integers only)", () => {
    expect(() =>
      LLMWorkflowSpecSchema.parse({
        ...baseLLMSpec,
        nodes: [{ ...toolNode, id: -1 }],
      }),
    ).toThrow();
  });

  it("rejects non-integer node ids", () => {
    expect(() =>
      LLMWorkflowSpecSchema.parse({
        ...baseLLMSpec,
        nodes: [{ ...toolNode, id: 1.5 }],
      }),
    ).toThrow();
  });

  it("allows an empty or omitted node.description", () => {
    expect(() =>
      LLMWorkflowSpecSchema.parse({
        ...baseLLMSpec,
        nodes: [{ ...toolNode, description: "" }],
      }),
    ).not.toThrow();
    const { description: _omit, ...noDesc } = toolNode;
    expect(() =>
      LLMWorkflowSpecSchema.parse({ ...baseLLMSpec, nodes: [noDesc] }),
    ).not.toThrow();
  });

  it("rejects an agent node missing the required inputs.task field", () => {
    // Strip inputs.task — the resulting node should fail to parse
    // as an LLMAgentNode (task is required).
    const broken = {
      id: 1,
      description: agentNode.description,
      depends_on: agentNode.depends_on,
      type: "agent" as const,
      inputs: { name: agentNode.inputs.name },
    };
    expect(() =>
      LLMWorkflowSpecSchema.parse({
        ...baseLLMSpec,
        nodes: [toolNode, broken],
      }),
    ).toThrow();
  });

  it("accepts execution config overrides (all fields optional)", () => {
    const withExec: LLMWorkflowSpec = {
      ...baseLLMSpec,
      execution: { timeout_seconds: 120, max_parallelism: 5, on_failure: "continue" },
    };
    const parsed = LLMWorkflowSpecSchema.parse(withExec);
    expect(parsed.execution).toEqual({
      timeout_seconds: 120,
      max_parallelism: 5,
      on_failure: "continue",
    });
  });

  it("rejects on_failure values outside the closed enum", () => {
    expect(() =>
      LLMWorkflowSpecSchema.parse({
        ...baseLLMSpec,
        execution: { on_failure: "ignore" },
      }),
    ).toThrow();
  });

  it("rejects retries.delay_seconds < 0 (seconds, not ms — D29 unit convention)", () => {
    expect(() =>
      LLMWorkflowSpecSchema.parse({
        ...baseLLMSpec,
        nodes: [{ ...toolNode, retries: { attempts: 1, delay_seconds: -1 } }],
      }),
    ).toThrow();
  });
});

describe("CanonicalWorkflowSpecSchema", () => {
  it("accepts a minimal valid canonical spec", () => {
    const parsed = CanonicalWorkflowSpecSchema.parse(baseCanonicalSpec);
    expect(parsed.nodes[0].type).toBe("tool");
    expect(parsed.nodes[1].type).toBe("agent");
  });

  it("requires every node to carry the bucket tag (type)", () => {
    // Strip the `type` field on the first node and re-cast as any
    // (intentionally producing an invalid value to test schema
    // rejection).
    const stripped = { ...canonicalToolNode };
    delete (stripped as Record<string, unknown>).type;
    expect(() =>
      CanonicalWorkflowSpecSchema.parse({
        ...baseCanonicalSpec,
        nodes: [stripped, canonicalAgentNode],
      }),
    ).toThrow();
  });

  it("requires agent node to carry resolved inputs.agent_id", () => {
    const { agent_id: _omit, ...inputsWithoutId } = canonicalAgentNode.inputs;
    void _omit;
    expect(() =>
      CanonicalWorkflowSpecSchema.parse({
        ...baseCanonicalSpec,
        nodes: [
          canonicalToolNode,
          { ...canonicalAgentNode, inputs: inputsWithoutId },
        ],
      }),
    ).toThrow();
  });

  it("rejects non-UUID inputs.agent_id", () => {
    expect(() =>
      CanonicalWorkflowSpecSchema.parse({
        ...baseCanonicalSpec,
        nodes: [
          canonicalToolNode,
          {
            ...canonicalAgentNode,
            inputs: { ...canonicalAgentNode.inputs, agent_id: "not-a-uuid" },
          },
        ],
      }),
    ).toThrow();
  });
});

// ─── Chart node schema ────────────────────────────────────────────────

describe("LLMChartNodeSchema", () => {
  const baseChartInputs = {
    renderer: "echarts" as const,
    config: { series: [{ type: "bar" }] },
    dataset: "@nodes.0.rows",
  };

  function chartSpecWith(
    chartOverride: Partial<{
      renderer: unknown;
      config: unknown;
      dataset: unknown;
    }>,
  ): unknown {
    return {
      name: "demo",
      nodes: [
        toolNode,
        {
          id: 1,
          description: "chart",
          depends_on: [0],
          type: "chart",
          inputs: {
            ...baseChartInputs,
            ...chartOverride,
          },
        },
      ],
      outputs: { option: "@nodes.1.option" },
    };
  }

  it("accepts a well-formed chart node", () => {
    expect(() =>
      LLMWorkflowSpecSchema.parse(chartSpecWith({})),
    ).not.toThrow();
  });

  it("accepts dataset as a non-empty string", () => {
    expect(() =>
      LLMWorkflowSpecSchema.parse(
        chartSpecWith({ dataset: "@nodes.0.rows" }),
      ),
    ).not.toThrow();
  });

  it("accepts dataset as an array of ≥2 refs", () => {
    expect(() =>
      LLMWorkflowSpecSchema.parse(
        chartSpecWith({
          dataset: ["@nodes.0.rows", "@nodes.0.rows"],
        }),
      ),
    ).not.toThrow();
  });

  it("rejects dataset as an empty string", () => {
    expect(() =>
      LLMWorkflowSpecSchema.parse(chartSpecWith({ dataset: "" })),
    ).toThrow();
  });

  it("rejects dataset as an array with fewer than 2 entries", () => {
    expect(() =>
      LLMWorkflowSpecSchema.parse(
        chartSpecWith({ dataset: ["@nodes.0.rows"] }),
      ),
    ).toThrow();
  });

  it("rejects renderer outside the enum", () => {
    expect(() =>
      LLMWorkflowSpecSchema.parse(
        chartSpecWith({ renderer: "plotly" }),
      ),
    ).toThrow();
  });

  it("rejects missing renderer", () => {
    expect(() =>
      LLMWorkflowSpecSchema.parse(
        chartSpecWith({ renderer: undefined }),
      ),
    ).toThrow();
  });

  it("rejects missing config", () => {
    expect(() =>
      LLMWorkflowSpecSchema.parse(
        chartSpecWith({ config: undefined }),
      ),
    ).toThrow();
  });

  it("accepts missing dataset (not-refreshable fallback)", () => {
    // When the save pipeline can't reconstruct a ref for the
    // chart's data, the chart is preserved with `dataset` absent
    // and the data baked into `config.dataset.source`. The schema
    // permits this shape — UI surfaces it as "not refreshable".
    expect(() =>
      LLMWorkflowSpecSchema.parse(
        chartSpecWith({ dataset: undefined }),
      ),
    ).not.toThrow();
  });
});
