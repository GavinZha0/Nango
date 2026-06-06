import { describe, expect, it } from "vitest";

import { WorkflowError } from "@/lib/workflows/error";
import {
  NODE_SCHEMA_VERSIONS,
  REF_RECON_ALGORITHM,
  canonicalize,
  type CanonicalizeDeps,
  type ToolMetadata,
} from "@/lib/workflows/spec/canonicalize";
import {
  CanonicalNodeSchema,
  CanonicalWorkflowSpecSchema,
  type LLMWorkflowSpec,
} from "@/lib/workflows/spec/schema";

// ─── Fixtures ─────────────────────────────────────────────────────────

const TOOL_META: Readonly<Record<string, ToolMetadata>> = {
  fetch_data_table: {
    input_schema: {
      type: "object",
      properties: {
        dataSourceId: { type: "string" },
        sql: { type: "string" },
      },
      required: ["dataSourceId", "sql"],
    },
    output_schema: {
      type: "object",
      properties: { dataset: { type: "string" }, rowCount: { type: "number" } },
      required: ["dataset", "rowCount"],
    },
    outputs: ["dataset", "rowCount"],
  },
  // Tool with metadata that has output_schema only — outputs[] must
  // fall back to `output_schema.required`.
  legacy_tool: {
    output_schema: {
      type: "object",
      properties: { result: { type: "string" } },
      required: ["result"],
    },
  },
  // Tool with no metadata fields at all — canonical node must still
  // succeed, just without input/output_schema.
  minimal_tool: {},
};

const AGENT_DIRECTORY: Readonly<Record<string, string>> = {
  "Builtin / DataAnalyst": "11111111-1111-4111-8111-111111111111",
  "Builtin / Reporter": "22222222-2222-4222-8222-222222222222",
};

function makeDeps(
  overrides?: Partial<CanonicalizeDeps>,
): CanonicalizeDeps {
  return {
    getToolMetadata: (name: string) => TOOL_META[name] ?? null,
    resolveAgentId: (display: string) => AGENT_DIRECTORY[display] ?? null,
    ...overrides,
  };
}

function baseSpec(
  nodesOverride?: LLMWorkflowSpec["nodes"],
  outputsOverride?: LLMWorkflowSpec["outputs"],
): LLMWorkflowSpec {
  return {
    version: "1.0",
    name: "demo",
    nodes: nodesOverride ?? [
      {
        id: 0,
        description: "Extract last 30d orders",
        depends_on: [],
        type: "tool",
        tool: "fetch_data_table",
        inputs: { dataSourceId: "orders_pg", sql: "select 1" },
      },
    ],
    outputs: outputsOverride ?? { dataset: "@nodes.0.dataset" },
  };
}

// ─── Happy paths ──────────────────────────────────────────────────────

describe("canonicalize — tool nodes", () => {
  it("stamps type='tool' and hydrates registry metadata", () => {
    const out = canonicalize(baseSpec(), makeDeps());
    expect(out.ref_recon_algorithm).toBe(REF_RECON_ALGORITHM);
    expect(out.nodes).toHaveLength(1);
    const node = out.nodes[0];
    if (node.type !== "tool") throw new Error("expected tool node");
    expect(node.tool).toBe("fetch_data_table");
    expect(node.input_schema).toEqual(
      TOOL_META.fetch_data_table!.input_schema,
    );
    expect(node.output_schema).toEqual(
      TOOL_META.fetch_data_table!.output_schema,
    );
    expect(node.outputs).toEqual(["dataset", "rowCount"]);
  });

  it("falls back to output_schema.required when outputs[] is absent", () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "Legacy tool",
        depends_on: [],
        type: "tool",
        tool: "legacy_tool",
        inputs: {},
      },
    ], { result: "@nodes.0.result" });
    const out = canonicalize(spec, makeDeps());
    const node = out.nodes[0];
    if (node.type !== "tool") throw new Error("expected tool node");
    expect(node.outputs).toEqual(["result"]);
  });

  it("omits input_schema / output_schema / outputs when registry has none", () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "Minimal tool",
        depends_on: [],
        type: "tool",
        tool: "minimal_tool",
        inputs: {},
      },
    ], { x: "@nodes.0.anything" });
    const out = canonicalize(spec, makeDeps());
    const node = out.nodes[0];
    if (node.type !== "tool") throw new Error("expected tool node");
    expect(node.input_schema).toBeUndefined();
    expect(node.output_schema).toBeUndefined();
    expect(node.outputs).toBeUndefined();
  });

  it("preserves LLM-supplied fields (id, description, depends_on, input)", () => {
    const spec = baseSpec([
      {
        id: 7,
        description: "Custom desc",
        depends_on: [3, 5],
        type: "tool",
        tool: "fetch_data_table",
        inputs: { dataSourceId: "x", sql: "select 1" },
        timeout_seconds: 120,
        retries: { attempts: 2, delay_seconds: 30 },
      },
    ], { dataset: "@nodes.7.dataset" });
    const out = canonicalize(spec, makeDeps());
    const node = out.nodes[0];
    expect(node.id).toBe(7);
    expect(node.description).toBe("Custom desc");
    expect(node.depends_on).toEqual([3, 5]);
    expect(node.timeout_seconds).toBe(120);
    expect(node.retries).toEqual({ attempts: 2, delay_seconds: 30 });
    if (node.type !== "tool") throw new Error("expected tool node");
    expect(node.inputs).toEqual({ dataSourceId: "x", sql: "select 1" });
  });
});

describe("canonicalize — agent nodes", () => {
  it("stamps type='agent' and resolves agentId one-shot", () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "Analyse dataset",
        depends_on: [],
        type: "agent",
        agent: "Builtin / DataAnalyst",
        inputs: { dataset: "@workflow.dataset" },
        output_schema: {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
        },
      },
    ], { summary: "@nodes.0.summary" });
    const out = canonicalize(spec, makeDeps());
    const node = out.nodes[0];
    if (node.type !== "agent") throw new Error("expected agent node");
    expect(node.agent).toBe("Builtin / DataAnalyst");
    expect(node.agent_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(node.output_schema).toEqual({
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    });
    expect(node.outputs).toEqual(["summary"]);
  });

  it("omits outputs[] when output_schema.required is missing/empty", () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "No required keys",
        depends_on: [],
        type: "agent",
        agent: "Builtin / DataAnalyst",
        inputs: {},
        output_schema: {
          type: "object",
          properties: { x: { type: "string" } },
        },
      },
    ], { x: "@nodes.0.x" });
    const out = canonicalize(spec, makeDeps());
    const node = out.nodes[0];
    if (node.type !== "agent") throw new Error("expected agent node");
    expect(node.outputs).toBeUndefined();
  });
});

// ─── D35 code nodes ───────────────────────────────────────────────────

describe("canonicalize — code nodes (D35)", () => {
  it("fills DEFAULT_CODE_NODE_OUTPUTS when no schema declared", () => {
    const spec = baseSpec(
      [
        {
          id: 0,
          type: "code",
          description: "run script",
          depends_on: [],
          language: "python",
          code: "print('hi')",
        },
      ],
      { result: "@nodes.0.stdout" },
    );
    const out = canonicalize(spec, makeDeps());
    const node = out.nodes[0];
    if (node.type !== "code") throw new Error("expected code node");
    expect(node.outputs).toEqual(["stdout", "stderr", "exit_code", "duration_ms"]);
  });

  it("derives outputs[] from output_schema.required when declared", () => {
    const spec = baseSpec(
      [
        {
          id: 0,
          type: "code",
          description: "compute stats",
          depends_on: [],
          language: "python",
          code: "import json; print(json.dumps({'mean': 5.0, 'std': 1.2}))",
          output_schema: {
            type: "object",
            properties: {
              mean: { type: "number" },
              std: { type: "number" },
            },
            required: ["mean", "std"],
          },
        },
      ],
      { mean: "@nodes.0.mean" },
    );
    const out = canonicalize(spec, makeDeps());
    const node = out.nodes[0];
    if (node.type !== "code") throw new Error("expected code node");
    expect(node.outputs).toEqual(["mean", "std"]);
  });

  it("falls back to output_schema.properties keys when required is absent", () => {
    // Code-node mode for deriveOutputsFromSchema enables the
    // properties fallback (agents stay required-only).
    const spec = baseSpec(
      [
        {
          id: 0,
          type: "code",
          description: "compute stats",
          depends_on: [],
          language: "python",
          code: "print('{}')",
          output_schema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "string" } },
          },
        },
      ],
      { a: "@nodes.0.a" },
    );
    const out = canonicalize(spec, makeDeps());
    const node = out.nodes[0];
    if (node.type !== "code") throw new Error("expected code node");
    expect(node.outputs).toEqual(["a", "b"]);
  });

  it("preserves LLM-supplied input, code, language, retries through canonicalize", () => {
    const spec = baseSpec(
      [
        {
          id: 3,
          type: "code",
          description: "load + count",
          depends_on: [0],
          language: "python",
          code: "x = 1\nprint(x)",
          inputs: { datasets: ["ds_xxxxxx"] },
          timeout_seconds: 60,
          retries: { attempts: 1, delay_seconds: 5 },
        },
      ],
      { x: "@nodes.3.stdout" },
    );
    const out = canonicalize(spec, makeDeps());
    const node = out.nodes[0];
    if (node.type !== "code") throw new Error("expected code node");
    expect(node.id).toBe(3);
    expect(node.language).toBe("python");
    expect(node.code).toBe("x = 1\nprint(x)");
    expect(node.inputs).toEqual({ datasets: ["ds_xxxxxx"] });
    expect(node.depends_on).toEqual([0]);
    expect(node.timeout_seconds).toBe(60);
    expect(node.retries).toEqual({ attempts: 1, delay_seconds: 5 });
  });

  it("does NOT consult getToolMetadata or resolveAgentId for code nodes", () => {
    // Code nodes are self-contained — no registry / catalog lookup.
    const calls: string[] = [];
    const deps: CanonicalizeDeps = {
      getToolMetadata: (name) => {
        calls.push(`tool:${name}`);
        return null;
      },
      resolveAgentId: (display) => {
        calls.push(`agent:${display}`);
        return null;
      },
    };
    const spec = baseSpec(
      [
        {
          id: 0,
          type: "code",
          description: "n",
          depends_on: [],
          language: "python",
          code: "pass",
        },
      ],
      { x: "@nodes.0.stdout" },
    );
    canonicalize(spec, deps);
    expect(calls).toEqual([]);
  });
});

describe("canonicalize — workflow-level enrichment", () => {
  it("stamps refReconAlgorithm at the workflow root", () => {
    const out = canonicalize(baseSpec(), makeDeps());
    expect(out.ref_recon_algorithm).toBe("ref_recon_v1");
  });

  it("preserves top-level outputs / description / input_schema / execution", () => {
    const spec: LLMWorkflowSpec = {
      version: "1.0",
      name: "demo",
      description: "Top-level description",
      input_schema: { type: "object", properties: { x: { type: "string" } } },
      execution: { max_parallelism: 4, timeout_seconds: 300, on_failure: "continue" },
      nodes: [
        {
          id: 0,
          description: "n",
          depends_on: [],
          type: "tool",
          tool: "minimal_tool",
          inputs: {},
        },
      ],
      outputs: { final: "@nodes.0.anything" },
    };
    const out = canonicalize(spec, makeDeps());
    expect(out.description).toBe("Top-level description");
    expect(out.input_schema).toEqual({
      type: "object",
      properties: { x: { type: "string" } },
    });
    expect(out.execution).toEqual({
      max_parallelism: 4,
      timeout_seconds: 300,
      on_failure: "continue",
    });
    expect(out.outputs).toEqual({ final: "@nodes.0.anything" });
  });

  it("output passes CanonicalWorkflowSpecSchema validation", () => {
    const out = canonicalize(baseSpec(), makeDeps());
    const parsed = CanonicalWorkflowSpecSchema.safeParse(out);
    expect(parsed.success).toBe(true);
  });
});

// ─── Error paths ──────────────────────────────────────────────────────

describe("canonicalize — TOOL_NOT_FOUND", () => {
  it("throws when tool is not in the registry", () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "Bad tool",
        depends_on: [],
        type: "tool",
        tool: "no_such_tool",
        inputs: {},
      },
    ], { x: "@nodes.0.x" });
    expect(() => canonicalize(spec, makeDeps())).toThrow(WorkflowError);
    try {
      canonicalize(spec, makeDeps());
    } catch (e) {
      if (!(e instanceof WorkflowError)) throw e;
      expect(e.errorCode).toBe("TOOL_NOT_FOUND");
      expect(e.nodeId).toBe(0);
      expect(e.nodeName).toBe("no_such_tool");
      expect(e.message).toContain("no_such_tool");
    }
  });
});

describe("canonicalize — AGENT_NOT_FOUND", () => {
  it("throws when agent display string can't resolve", () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "Unknown agent",
        depends_on: [],
        type: "agent",
        agent: "Builtin / Ghost",
        inputs: {},
        output_schema: {
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"],
        },
      },
    ], { x: "@nodes.0.x" });
    try {
      canonicalize(spec, makeDeps());
      throw new Error("should have thrown");
    } catch (e) {
      if (!(e instanceof WorkflowError)) throw e;
      expect(e.errorCode).toBe("AGENT_NOT_FOUND");
      expect(e.nodeId).toBe(0);
      expect(e.nodeName).toBe("Builtin / Ghost");
    }
  });
});

// D35 retired the field-presence discriminator (tool vs agent) in
// favour of an explicit `type` field. The runtime
// `SPEC_DISCRIMINATOR_AMBIGUOUS` / `_MISSING` throw sites in
// `canonicalize.ts` are gone — Zod's discriminated union catches
// both shapes at parse time before canonicalize is ever called.
// The previous tests for those code paths have been deleted; the
// error codes themselves remain in the WorkflowErrorCode union
// for legacy persisted-spec readers but no V1.x save / refresh
// path can emit them.

describe("canonicalize — fail-fast on first node error", () => {
  it("does not call deps for nodes after the failing one", () => {
    const callLog: string[] = [];
    const deps: CanonicalizeDeps = {
      getToolMetadata: (name) => {
        callLog.push(`tool:${name}`);
        return name === "minimal_tool" ? {} : null;
      },
      resolveAgentId: (display) => {
        callLog.push(`agent:${display}`);
        return AGENT_DIRECTORY[display] ?? null;
      },
    };
    const spec = baseSpec([
      {
        id: 0,
        description: "fine",
        depends_on: [],
        type: "tool",
        tool: "minimal_tool",
        inputs: {},
      },
      {
        id: 1,
        description: "fails here",
        depends_on: [0],
        type: "tool",
        tool: "no_such_tool",
        inputs: {},
      },
      {
        id: 2,
        description: "never reached",
        depends_on: [1],
        type: "tool",
        tool: "minimal_tool",
        inputs: {},
      },
    ], { x: "@nodes.0.anything" });
    expect(() => canonicalize(spec, deps)).toThrow(WorkflowError);
    // node 0 (minimal_tool) + node 1 (no_such_tool) only.
    expect(callLog).toEqual(["tool:minimal_tool", "tool:no_such_tool"]);
  });
});

// ─── D36: SQL node canonicalization ───────────────────────────────────

describe("canonicalize — SQL node (D36)", () => {
  const noopDeps: CanonicalizeDeps = {
    getToolMetadata: () => null,
    resolveAgentId: () => null,
  };

  it("preserves all first-class fields and stamps DEFAULT_SQL_NODE_OUTPUTS", () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "extract orders",
        depends_on: [],
        type: "sql",
        data_source_name: "prod_pg",
        query: "SELECT id, total FROM orders",
        name: "ds_orders",
      },
    ], { result: "@nodes.0.name" });
    const canonical = canonicalize(spec, noopDeps);
    const node = canonical.nodes[0]!;
    if (node.type !== "sql") throw new Error("expected sql node");
    expect(node.data_source_name).toBe("prod_pg");
    expect(node.query).toBe("SELECT id, total FROM orders");
    expect(node.name).toBe("ds_orders");
    expect(node.outputs).toEqual(["name", "row_count", "rows"]);
  });

  it("does NOT consult getToolMetadata or resolveAgentId for SQL nodes", () => {
    const callLog: string[] = [];
    const deps: CanonicalizeDeps = {
      getToolMetadata: (name) => {
        callLog.push(`tool:${name}`);
        return null;
      },
      resolveAgentId: (display) => {
        callLog.push(`agent:${display}`);
        return null;
      },
    };
    const spec = baseSpec([
      {
        id: 0,
        description: "extract",
        depends_on: [],
        type: "sql",
        data_source_name: "any_slug",
        query: "SELECT 1",
      },
    ], { result: "@nodes.0.name" });
    canonicalize(spec, deps);
    expect(callLog).toEqual([]);
  });

  it("keeps node.name undefined when LLM-emit omits it", () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "extract",
        depends_on: [],
        type: "sql",
        data_source_name: "src",
        query: "SELECT 1",
      },
    ], { result: "@nodes.0.name" });
    const canonical = canonicalize(spec, noopDeps);
    const node = canonical.nodes[0]!;
    if (node.type !== "sql") throw new Error("expected sql node");
    expect(node.name).toBeUndefined();
  });

  it("canonical SQL node passes CanonicalWorkflowSpecSchema", () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "extract",
        depends_on: [],
        type: "sql",
        data_source_name: "src",
        query: "SELECT 1",
        name: "ds_x",
      },
    ], { result: "@nodes.0.name" });
    const canonical = canonicalize(spec, noopDeps);
    const parsed = CanonicalWorkflowSpecSchema.safeParse(canonical);
    expect(parsed.success).toBe(true);
  });

  it("stamps refReconAlgorithm at the workflow level (consistent with tool/agent/code)", () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "extract",
        depends_on: [],
        type: "sql",
        data_source_name: "src",
        query: "SELECT 1",
      },
    ], { result: "@nodes.0.name" });
    const canonical = canonicalize(spec, noopDeps);
    expect(canonical.ref_recon_algorithm).toBe(REF_RECON_ALGORITHM);
  });
});

// ─── schema_version stamping + backward compat ────────────────────────

describe("canonicalize — per-node schema_version", () => {
  it("exposes a NODE_SCHEMA_VERSIONS entry for every NodeType", () => {
    // Whenever a new node type lands in `NodeTypeSchema`, this guard
    // forces an explicit `NODE_SCHEMA_VERSIONS[type] = "1"` decision
    // rather than silently shipping unstamped nodes.
    expect(Object.keys(NODE_SCHEMA_VERSIONS).sort()).toEqual(
      ["agent", "chart", "code", "sql", "tool"],
    );
    for (const v of Object.values(NODE_SCHEMA_VERSIONS)) {
      expect(v).toBe("1");
    }
  });

  it("stamps schema_version='1' on a tool node", () => {
    const canonical = canonicalize(baseSpec(), makeDeps());
    expect(canonical.nodes[0]!.schema_version).toBe("1");
  });

  it("stamps schema_version='1' on an agent node", () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "summarise",
        depends_on: [],
        type: "agent",
        agent: "Builtin / DataAnalyst",
        inputs: { text: "hi" },
        output_schema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ], { result: "@nodes.0.text" });
    const canonical = canonicalize(spec, makeDeps());
    expect(canonical.nodes[0]!.schema_version).toBe("1");
  });

  it("stamps schema_version='1' on a code node", () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "compute",
        depends_on: [],
        type: "code",
        language: "python",
        code: "print(1)",
      },
    ], { result: "@nodes.0.stdout" });
    const canonical = canonicalize(spec, makeDeps());
    expect(canonical.nodes[0]!.schema_version).toBe("1");
  });

  it("stamps schema_version='1' on a SQL node", () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "extract",
        depends_on: [],
        type: "sql",
        data_source_name: "src",
        query: "SELECT 1",
      },
    ], { result: "@nodes.0.name" });
    const canonical = canonicalize(spec, makeDeps());
    expect(canonical.nodes[0]!.schema_version).toBe("1");
  });

  it("defaults schema_version to '1' when absent (backward compat for pre-versioning DB rows)", () => {
    // Old workflow rows persisted before this field existed parse as
    // if they had `schema_version: "1"` — no migration required.
    const rawOldNode = {
      type: "tool",
      id: 0,
      description: "legacy",
      depends_on: [],
      tool: "fetch_data_table",
      inputs: {},
    };
    const parsed = CanonicalNodeSchema.parse(rawOldNode);
    expect(parsed.schema_version).toBe("1");
  });

  it("rejects an unknown schema_version (future v2 spec parsed by a v1 build)", () => {
    const rawFutureNode = {
      type: "tool",
      schema_version: "2",
      id: 0,
      description: "future",
      depends_on: [],
      tool: "fetch_data_table",
      inputs: {},
    };
    expect(() => CanonicalNodeSchema.parse(rawFutureNode)).toThrow();
  });
});

// ─── Chart node canonicalization ──────────────────────────────────────

describe("canonicalize — chart node", () => {
  const noopDeps: CanonicalizeDeps = {
    getToolMetadata: () => null,
    resolveAgentId: () => null,
  };

  function chartSpec(): LLMWorkflowSpec {
    return {
      version: "1.0",
      name: "demo",
      nodes: [
        {
          id: 0,
          description: "extract",
          depends_on: [],
          type: "sql",
          data_source_name: "src",
          query: "SELECT month, sales FROM orders",
          name: "monthly_sales",
        },
        {
          id: 1,
          description: "bar chart of monthly sales",
          depends_on: [0],
          type: "chart",
          inputs: {
            renderer: "echarts",
            config: {
              xAxis: { type: "category" },
              yAxis: { type: "value" },
              series: [
                {
                  type: "bar",
                  encode: { x: "month", y: "sales" },
                },
              ],
            },
            dataset: "@nodes.0.rows",
          },
        },
      ],
      outputs: { option: "@nodes.1.option" },
    };
  }

  it("preserves inputs.{renderer,config,dataset} verbatim", () => {
    const canonical = canonicalize(chartSpec(), noopDeps);
    const node = canonical.nodes[1]!;
    if (node.type !== "chart") throw new Error("expected chart node");
    expect(node.inputs.renderer).toBe("echarts");
    expect(node.inputs.config).toMatchObject({
      xAxis: { type: "category" },
      series: [{ type: "bar", encode: { x: "month", y: "sales" } }],
    });
    expect(node.inputs.dataset).toBe("@nodes.0.rows");
  });

  it("stamps outputs[] = ['option']", () => {
    const canonical = canonicalize(chartSpec(), noopDeps);
    const node = canonical.nodes[1]!;
    if (node.type !== "chart") throw new Error("expected chart node");
    expect(node.outputs).toEqual(["option"]);
  });

  it("stamps output_schema with `option` as the only required key", () => {
    const canonical = canonicalize(chartSpec(), noopDeps);
    const node = canonical.nodes[1]!;
    if (node.type !== "chart") throw new Error("expected chart node");
    expect(node.output_schema).toMatchObject({
      type: "object",
      required: ["option"],
    });
    expect(node.output_schema?.properties).toMatchObject({
      option: { type: "object" },
    });
  });

  it("const-pins input_schema.properties.renderer to the chosen value", () => {
    const canonical = canonicalize(chartSpec(), noopDeps);
    const node = canonical.nodes[1]!;
    if (node.type !== "chart") throw new Error("expected chart node");
    const props = node.input_schema?.properties as Record<string, unknown>;
    expect(props?.renderer).toEqual({ const: "echarts" });
    expect(node.input_schema?.required).toEqual([
      "renderer",
      "config",
    ]);
    // `dataset` is documented as optional — when the save pipeline
    // can't reconstruct a ref, the chart is the not-refreshable
    // fallback (data baked into config). The Zod / JSON schema
    // honours that by keeping `dataset` out of `required` while
    // still describing its expected shape under `properties`.
    expect(props?.dataset).toBeDefined();
  });

  it("does NOT consult getToolMetadata or resolveAgentId for chart nodes", () => {
    const callLog: string[] = [];
    const deps: CanonicalizeDeps = {
      getToolMetadata: (name) => {
        callLog.push(`tool:${name}`);
        return null;
      },
      resolveAgentId: (display) => {
        callLog.push(`agent:${display}`);
        return null;
      },
    };
    const spec = chartSpec();
    // strip the sql node so only the chart node runs through canonicalize
    spec.nodes = [
      {
        ...spec.nodes[1]!,
        id: 0,
        depends_on: [],
      },
    ];
    spec.outputs = { option: "@nodes.0.option" };
    canonicalize(spec, deps);
    expect(callLog).toEqual([]);
  });

  it("supports multi-dataset (array of refs) — passes Zod min(2)", () => {
    const spec = chartSpec();
    if (spec.nodes[1]!.type !== "chart") throw new Error();
    spec.nodes[1] = {
      ...spec.nodes[1]!,
      inputs: {
        ...spec.nodes[1]!.inputs,
        dataset: ["@nodes.0.rows", "@nodes.0.rows"],
      },
    };
    const canonical = canonicalize(spec, noopDeps);
    const node = canonical.nodes[1]!;
    if (node.type !== "chart") throw new Error("expected chart node");
    expect(node.inputs.dataset).toEqual([
      "@nodes.0.rows",
      "@nodes.0.rows",
    ]);
  });

  it("stamps schema_version='1' on a chart node", () => {
    const canonical = canonicalize(chartSpec(), noopDeps);
    expect(canonical.nodes[1]!.schema_version).toBe("1");
  });

  it("canonical chart node round-trips through CanonicalWorkflowSpecSchema", () => {
    const canonical = canonicalize(chartSpec(), noopDeps);
    const parsed = CanonicalWorkflowSpecSchema.safeParse(canonical);
    expect(parsed.success).toBe(true);
  });
});
