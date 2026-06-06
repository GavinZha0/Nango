import { describe, expect, it } from "vitest";

import {
  CanonicalWorkflowSpecSchema,
  DEFAULT_AGENT_OUTPUT_SCHEMA,
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
  type: "tool",
  tool: "fetch_data_table",
  inputs: { dataSourceName: "warehouse_prod", sql: "SELECT *" },
};

const agentNode: LLMAgentNode = {
  id: 1,
  description: "Summarise anomalies",
  depends_on: [0],
  type: "agent",
  agent: "Nango Builtin / Data Analyst",
  inputs: { data: "@nodes.0.dataset", task: "find anomalies" },
  output_schema: DEFAULT_AGENT_OUTPUT_SCHEMA,
};

const baseLLMSpec: LLMWorkflowSpec = {
  version: "1.0",
  name: "Q4 Sales Analysis",
  nodes: [toolNode, agentNode],
  outputs: { summary: "@nodes.1.text" },
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
  agent_id: "550e8400-e29b-41d4-a716-446655440000",
};
const baseCanonicalSpec: CanonicalWorkflowSpec = {
  ...baseLLMSpec,
  ref_recon_algorithm: "ref_recon_v1",
  nodes: [canonicalToolNode, canonicalAgentNode],
};

describe("LLMWorkflowSpecSchema", () => {
  it("accepts a minimal valid LLM-emit spec", () => {
    const parsed = LLMWorkflowSpecSchema.parse(baseLLMSpec);
    expect(parsed.name).toBe("Q4 Sales Analysis");
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.outputs).toEqual({ summary: "@nodes.1.text" });
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

  it("requires node.description per D7", () => {
    expect(() =>
      LLMWorkflowSpecSchema.parse({
        ...baseLLMSpec,
        nodes: [{ ...toolNode, description: "" }],
      }),
    ).toThrow();
  });

  it("requires agent node to declare output_schema", () => {
    // Strip output_schema — the resulting node should fail to
    // parse as either an LLMToolNode (no tool field) or an
    // LLMAgentNode (no output_schema).
    const broken = {
      id: 1,
      description: agentNode.description,
      depends_on: agentNode.depends_on,
      agent: agentNode.agent,
      inputs: agentNode.inputs,
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
    expect(parsed.ref_recon_algorithm).toBe("ref_recon_v1");
    expect(parsed.nodes[0].type).toBe("tool");
    expect(parsed.nodes[1].type).toBe("agent");
  });

  it("requires the refReconAlgorithm tag (D26)", () => {
    const { ref_recon_algorithm: _omit, ...withoutTag } = baseCanonicalSpec;
    void _omit;
    expect(() => CanonicalWorkflowSpecSchema.parse(withoutTag)).toThrow();
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

  it("requires agent node to carry resolved agentId (D27)", () => {
    const { agent_id: _omit, ...incomplete } = canonicalAgentNode;
    void _omit;
    expect(() =>
      CanonicalWorkflowSpecSchema.parse({
        ...baseCanonicalSpec,
        nodes: [canonicalToolNode, incomplete],
      }),
    ).toThrow();
  });

  it("rejects non-UUID agentId", () => {
    expect(() =>
      CanonicalWorkflowSpecSchema.parse({
        ...baseCanonicalSpec,
        nodes: [
          canonicalToolNode,
          { ...canonicalAgentNode, agent_id: "not-a-uuid" },
        ],
      }),
    ).toThrow();
  });
});

describe("DEFAULT_AGENT_OUTPUT_SCHEMA (D30)", () => {
  it("matches the { text: string } shape the save pipeline writes", () => {
    expect(DEFAULT_AGENT_OUTPUT_SCHEMA).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
  });

  it("parses cleanly as an agent node's output_schema field", () => {
    // Round-trip: take the default constant, plug it into an agent
    // node, parse the spec — should succeed without modification.
    const node: LLMAgentNode = {
      ...agentNode,
      output_schema: { ...DEFAULT_AGENT_OUTPUT_SCHEMA },
    };
    const spec: LLMWorkflowSpec = { ...baseLLMSpec, nodes: [toolNode, node] };
    expect(() => LLMWorkflowSpecSchema.parse(spec)).not.toThrow();
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
      version: "1.0",
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
