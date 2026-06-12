import { describe, expect, it } from "vitest";

import { WorkflowError } from "@/lib/workflows/error";
import {
  NODE_SCHEMA_VERSIONS,
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

const DATA_SOURCE_DIRECTORY: Readonly<Record<string, string>> = {
  prod_pg: "33333333-3333-4333-8333-333333333333",
  warehouse: "44444444-4444-4444-8444-444444444444",
  src: "55555555-5555-4555-8555-555555555555",
};

function makeDeps(
  overrides?: Partial<CanonicalizeDeps>,
): CanonicalizeDeps {
  return {
    getToolMetadata: async (name: string) => TOOL_META[name] ?? null,
    resolveAgentId: async (display: string) => AGENT_DIRECTORY[display] ?? null,
    resolveDataSourceId: async (name: string) =>
      DATA_SOURCE_DIRECTORY[name] ?? null,
    ...overrides,
  };
}

function baseSpec(
  nodesOverride?: LLMWorkflowSpec["nodes"],
  outputsOverride?: LLMWorkflowSpec["outputs"],
): LLMWorkflowSpec {
  return {
    name: "demo",
    nodes: nodesOverride ?? [
      {
        id: 0,
        description: "Extract last 30d orders",
        depends_on: [],
        type: "tool",        inputs: {
          name: "fetch_data_table",
          arguments: { dataSourceId: "orders_pg", sql: "select 1" },
        },
      },
    ],
    outputs: outputsOverride ?? { dataset: "@nodes.0.dataset" },
  };
}

// ─── Happy paths ──────────────────────────────────────────────────────

describe("canonicalize — tool nodes", () => {
  it("stamps type='tool' and hydrates registry metadata", async () => {
    const out = await canonicalize(baseSpec(), makeDeps());
    expect(out.nodes).toHaveLength(1);
    const node = out.nodes[0];
    if (node.type !== "tool") throw new Error("expected tool node");
    expect(node.inputs.name).toBe("fetch_data_table");
    // input_schema is the WRAPPER stamped by canonicalize: it pins
    // `name` to the const tool name and lifts the registry's args
    // schema under `properties.arguments`.
    expect(node.input_schema).toMatchObject({
      type: "object",
      properties: {
        name: { const: "fetch_data_table" },
        arguments: TOOL_META.fetch_data_table!.input_schema,
      },
      required: ["name", "arguments"],
    });
    expect(node.output_schema).toEqual(
      TOOL_META.fetch_data_table!.output_schema,
    );
    expect(node.outputs).toEqual(["dataset", "rowCount"]);
  });

  it("falls back to output_schema.required when outputs[] is absent", async () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "Legacy tool",
        depends_on: [],
        type: "tool",        inputs: {
          name: "legacy_tool",
          arguments: {},
        },
      },
    ], { result: "@nodes.0.result" });
    const out = await canonicalize(spec, makeDeps());
    const node = out.nodes[0];
    if (node.type !== "tool") throw new Error("expected tool node");
    expect(node.outputs).toEqual(["result"]);
  });

  it("stamps a permissive input_schema wrapper when registry has no args schema; omits output_schema / outputs", async () => {
    // D40.A semantics: canonicalize ALWAYS stamps the
    // `{ name: const, arguments: <args> }` wrapper input_schema —
    // even when the registry returns no args schema. In that case
    // `arguments` falls back to "any object".
    const spec = baseSpec([
      {
        id: 0,
        description: "Minimal tool",
        depends_on: [],
        type: "tool",
        inputs: {
          name: "minimal_tool",
          arguments: {},
        },
      },
    ], { x: "@nodes.0.anything" });
    const out = await canonicalize(spec, makeDeps());
    const node = out.nodes[0];
    if (node.type !== "tool") throw new Error("expected tool node");
    expect(node.input_schema).toMatchObject({
      type: "object",
      properties: {
        name: { const: "minimal_tool" },
        arguments: { type: "object", additionalProperties: true },
      },
      required: ["name", "arguments"],
    });
    expect(node.output_schema).toBeUndefined();
    expect(node.outputs).toBeUndefined();
  });

  it("preserves LLM-supplied fields (id, description, depends_on, input)", async () => {
    const spec = baseSpec([
      {
        id: 7,
        description: "Custom desc",
        depends_on: [3, 5],
        type: "tool",        inputs: {
          name: "fetch_data_table",
          arguments: { dataSourceId: "x", sql: "select 1" },
        },
        timeout_seconds: 120,
        retries: { attempts: 2, delay_seconds: 30 },
      },
    ], { dataset: "@nodes.7.dataset" });
    const out = await canonicalize(spec, makeDeps());
    const node = out.nodes[0];
    expect(node.id).toBe(7);
    expect(node.description).toBe("Custom desc");
    expect(node.depends_on).toEqual([3, 5]);
    expect(node.timeout_seconds).toBe(120);
    expect(node.retries).toEqual({ attempts: 2, delay_seconds: 30 });
    if (node.type !== "tool") throw new Error("expected tool node");
    expect(node.inputs).toEqual({
      name: "fetch_data_table",
      arguments: { dataSourceId: "x", sql: "select 1" },
    });
  });
});

describe("canonicalize — agent nodes", () => {
  it("stamps type='agent' and resolves agentId one-shot", async () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "Analyse dataset",
        depends_on: [],
        type: "agent",
        inputs: {
          name: "Builtin / DataAnalyst",
          task: "@workflow.dataset",
        },
      },
    ], { result: "@nodes.0.result" });
    const out = await canonicalize(spec, makeDeps());
    const node = out.nodes[0];
    if (node.type !== "agent") throw new Error("expected agent node");
    expect(node.inputs.name).toBe("Builtin / DataAnalyst");
    expect(node.inputs.agent_id).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("stamps fixed outputs[] = ['result'] regardless of LLM-emit shape", async () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "Agent task only",
        depends_on: [],
        type: "agent",
        inputs: {
          name: "Builtin / DataAnalyst",
          task: "Analyse",
        },
      },
    ], { result: "@nodes.0.result" });
    const out = await canonicalize(spec, makeDeps());
    const node = out.nodes[0];
    if (node.type !== "agent") throw new Error("expected agent node");
  });
});

// ─── D35 code nodes ───────────────────────────────────────────────────

describe("canonicalize — code nodes (D35)", () => {
  it("fills DEFAULT_CODE_NODE_OUTPUTS when no schema declared", async () => {
    const spec = baseSpec(
      [
        {
          id: 0,
          type: "code",
          description: "run script",
          depends_on: [],
          inputs: { language: "python", code_text: "print('hi')" },
        },
      ],
      { result: "@nodes.0.stdout" },
    );
    const out = await canonicalize(spec, makeDeps());
    const node = out.nodes[0];
    if (node.type !== "code") throw new Error("expected code node");
  });

  it("canonicalizes a code node with code_text successfully", async () => {
    const spec = baseSpec(
      [
        {
          id: 0,
          type: "code",
          description: "compute stats",
          depends_on: [],
          inputs: {
            language: "python",
            code_text:
              "import json; print(json.dumps({'mean': 5.0, 'std': 1.2}))",
          },
        },
      ],
      { mean: "@nodes.0.mean" },
    );
    const out = await canonicalize(spec, makeDeps());
    const node = out.nodes[0];
    if (node.type !== "code") throw new Error("expected code node");
  });

  it("canonicalizes a minimal code node (code_text only, no extra fields)", async () => {
    const spec = baseSpec(
      [
        {
          id: 0,
          type: "code",
          description: "compute stats",
          depends_on: [],
          inputs: { language: "python", code_text: "print('{}')" },
        },
      ],
      { a: "@nodes.0.a" },
    );
    const out = await canonicalize(spec, makeDeps());
    const node = out.nodes[0];
    if (node.type !== "code") throw new Error("expected code node");
  });

  it("preserves LLM-supplied input, code, language, retries through canonicalize", async () => {
    const spec = baseSpec(
      [
        {
          id: 3,
          type: "code",
          description: "load + count",
          depends_on: [0],
          inputs: {
            language: "python",
            code_text: "x = 1\nprint(x)",
            datasets: ["ds_xxxxxx"],
          },
          timeout_seconds: 60,
          retries: { attempts: 1, delay_seconds: 5 },
        },
      ],
      { x: "@nodes.3.stdout" },
    );
    const out = await canonicalize(spec, makeDeps());
    const node = out.nodes[0];
    if (node.type !== "code") throw new Error("expected code node");
    expect(node.id).toBe(3);
    expect(node.inputs).toEqual({
      language: "python",
      code_text: "x = 1\nprint(x)",
      datasets: ["ds_xxxxxx"],
    });
    expect(node.depends_on).toEqual([0]);
    expect(node.timeout_seconds).toBe(60);
    expect(node.retries).toEqual({ attempts: 1, delay_seconds: 5 });
  });

  it("does NOT consult getToolMetadata or resolveAgentId for code nodes", async () => {
    // Code nodes are self-contained — no registry / catalog lookup.
    const calls: string[] = [];
    const deps: CanonicalizeDeps = {
      getToolMetadata: async (name) => {
        calls.push(`tool:${name}`);
        return null;
      },
      resolveAgentId: async (display) => {
        calls.push(`agent:${display}`);
        return null;
      },
      resolveDataSourceId: async () => null,
    };
    const spec = baseSpec(
      [
        {
          id: 0,
          type: "code",
          description: "n",
          depends_on: [],
          inputs: { language: "python", code_text: "pass" },
        },
      ],
      { x: "@nodes.0.stdout" },
    );
    await canonicalize(spec, deps);
    expect(calls).toEqual([]);
  });
});

describe("canonicalize — workflow-level enrichment", () => {
  it("preserves top-level outputs / description / input_schema / execution", async () => {
    const spec: LLMWorkflowSpec = {
      name: "demo",
      description: "Top-level description",
      input_schema: { type: "object", properties: { x: { type: "string" } } },
      execution: { max_parallelism: 4, timeout_seconds: 300, on_failure: "continue" },
      nodes: [
        {
          id: 0,
          description: "n",
          depends_on: [],
          type: "tool",          inputs: {
            name: "minimal_tool",
            arguments: {},
          },
        },
      ],
      outputs: { final: "@nodes.0.anything" },
    };
    const out = await canonicalize(spec, makeDeps());
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

  it("output passes CanonicalWorkflowSpecSchema validation", async () => {
    const out = await canonicalize(baseSpec(), makeDeps());
    const parsed = CanonicalWorkflowSpecSchema.safeParse(out);
    expect(parsed.success).toBe(true);
  });
});

// ─── Error paths ──────────────────────────────────────────────────────

describe("canonicalize — TOOL_NOT_FOUND", () => {
  it("throws when tool is not in the registry", async () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "Bad tool",
        depends_on: [],
        type: "tool",        inputs: {
          name: "no_such_tool",
          arguments: {},
        },
      },
    ], { x: "@nodes.0.x" });
    await expect(canonicalize(spec, makeDeps())).rejects.toThrow(WorkflowError);
    try {
      await canonicalize(spec, makeDeps());
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
  it("throws when agent display string can't resolve", async () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "Unknown agent",
        depends_on: [],
        type: "agent",
        inputs: {
          name: "Builtin / Ghost",
          task: "(any)",
        },
      },
    ], { result: "@nodes.0.result" });
    try {
      await canonicalize(spec, makeDeps());
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
  it("does not call deps for nodes after the failing one", async () => {
    const callLog: string[] = [];
    const deps: CanonicalizeDeps = {
      getToolMetadata: async (name) => {
        callLog.push(`tool:${name}`);
        return name === "minimal_tool" ? {} : null;
      },
      resolveAgentId: async (display) => {
        callLog.push(`agent:${display}`);
        return AGENT_DIRECTORY[display] ?? null;
      },
      resolveDataSourceId: async () => null,
    };
    const spec = baseSpec([
      {
        id: 0,
        description: "fine",
        depends_on: [],
        type: "tool",        inputs: {
          name: "minimal_tool",
          arguments: {},
        },
      },
      {
        id: 1,
        description: "fails here",
        depends_on: [0],
        type: "tool",        inputs: {
          name: "no_such_tool",
          arguments: {},
        },
      },
      {
        id: 2,
        description: "never reached",
        depends_on: [1],
        type: "tool",        inputs: {
          name: "minimal_tool",
          arguments: {},
        },
      },
    ], { x: "@nodes.0.anything" });
    await expect(canonicalize(spec, deps)).rejects.toThrow(WorkflowError);
    // node 0 (minimal_tool) + node 1 (no_such_tool) only.
    expect(callLog).toEqual(["tool:minimal_tool", "tool:no_such_tool"]);
  });
});

// ─── D36: SQL node canonicalization ───────────────────────────────────

describe("canonicalize — SQL node (D36)", () => {
  /**
   * Stub data-source UUID. The real canonicalize requires a UUID to
   * stamp `inputs.data_source_id`; the tests pin one to keep the
   * fixtures terse.
   */
  const STUB_DS_ID = "00000000-0000-4000-8000-000000000000";
  const stubDeps: CanonicalizeDeps = {
    getToolMetadata: async () => null,
    resolveAgentId: async () => null,
    resolveDataSourceId: async () => STUB_DS_ID,
  };

  it("preserves all first-class fields and stamps DEFAULT_SQL_NODE_OUTPUTS", async () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "extract orders",
        depends_on: [],
        type: "sql",
        inputs: {
          data_source_name: "prod_pg",
          sql_text: "SELECT id, total FROM orders",
          dataset_name: "ds_orders",
        },
      },
    ], { result: "@nodes.0.dataset_name" });
    const canonical = await canonicalize(spec, stubDeps);
    const node = canonical.nodes[0]!;
    if (node.type !== "sql") throw new Error("expected sql node");
    expect(node.inputs.data_source_name).toBe("prod_pg");
    expect(node.inputs.data_source_id).toBe(STUB_DS_ID);
    expect(node.inputs.sql_text).toBe("SELECT id, total FROM orders");
    expect(node.inputs.dataset_name).toBe("ds_orders");
  });

  it("does NOT consult getToolMetadata or resolveAgentId for SQL nodes", async () => {
    const callLog: string[] = [];
    const deps: CanonicalizeDeps = {
      getToolMetadata: async (name) => {
        callLog.push(`tool:${name}`);
        return null;
      },
      resolveAgentId: async (display) => {
        callLog.push(`agent:${display}`);
        return null;
      },
      resolveDataSourceId: async () => STUB_DS_ID,
    };
    const spec = baseSpec([
      {
        id: 0,
        description: "extract",
        depends_on: [],
        type: "sql",
        inputs: {
          data_source_name: "any_slug",
          sql_text: "SELECT 1",
        },
      },
    ], { result: "@nodes.0.dataset_name" });
    await canonicalize(spec, deps);
    expect(callLog).toEqual([]);
  });

  it("throws DATA_SOURCE_NOT_FOUND when the slug can't resolve to a UUID", async () => {
    const noResolveDeps: CanonicalizeDeps = {
      getToolMetadata: async () => null,
      resolveAgentId: async () => null,
      resolveDataSourceId: async () => null,
    };
    const spec = baseSpec([
      {
        id: 0,
        description: "extract",
        depends_on: [],
        type: "sql",
        inputs: {
          data_source_name: "missing_slug",
          sql_text: "SELECT 1",
        },
      },
    ], { result: "@nodes.0.dataset_name" });
    await expect(canonicalize(spec, noResolveDeps)).rejects.toThrowError(
      /data source 'missing_slug'/,
    );
  });

  it("keeps inputs.dataset_name undefined when LLM-emit omits it", async () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "extract",
        depends_on: [],
        type: "sql",
        inputs: {
          data_source_name: "src",
          sql_text: "SELECT 1",
        },
      },
    ], { result: "@nodes.0.dataset_name" });
    const canonical = await canonicalize(spec, stubDeps);
    const node = canonical.nodes[0]!;
    if (node.type !== "sql") throw new Error("expected sql node");
    expect(node.inputs.dataset_name).toBeUndefined();
  });

  it("canonical SQL node passes CanonicalWorkflowSpecSchema", async () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "extract",
        depends_on: [],
        type: "sql",
        inputs: {
          data_source_name: "src",
          sql_text: "SELECT 1",
          dataset_name: "ds_x",
        },
      },
    ], { result: "@nodes.0.dataset_name" });
    const canonical = await canonicalize(spec, stubDeps);
    const parsed = CanonicalWorkflowSpecSchema.safeParse(canonical);
    expect(parsed.success).toBe(true);
  });

});

// ─── schema_version stamping + backward compat ────────────────────────

describe("canonicalize — per-node schema_version", () => {
  it("exposes a NODE_SCHEMA_VERSIONS entry for every NodeType", async () => {
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

  it("stamps schema_version='1' on a tool node", async () => {
    const canonical = await canonicalize(baseSpec(), makeDeps());
    expect(canonical.nodes[0]!.schema_version).toBe("1");
  });

  it("stamps schema_version='1' on an agent node", async () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "summarise",
        depends_on: [],
        type: "agent",
        inputs: {
          name: "Builtin / DataAnalyst",
          task: "Say hi",
        },
      },
    ], { result: "@nodes.0.result" });
    const canonical = await canonicalize(spec, makeDeps());
    expect(canonical.nodes[0]!.schema_version).toBe("1");
  });

  it("stamps schema_version='1' on a code node", async () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "compute",
        depends_on: [],
        type: "code",
        inputs: { language: "python", code_text: "print(1)" },
      },
    ], { result: "@nodes.0.stdout" });
    const canonical = await canonicalize(spec, makeDeps());
    expect(canonical.nodes[0]!.schema_version).toBe("1");
  });

  it("stamps schema_version='1' on a SQL node", async () => {
    const spec = baseSpec([
      {
        id: 0,
        description: "extract",
        depends_on: [],
        type: "sql",
        inputs: {
          data_source_name: "src",
          sql_text: "SELECT 1",
        },
      },
    ], { result: "@nodes.0.dataset_name" });
    const canonical = await canonicalize(spec, makeDeps());
    expect(canonical.nodes[0]!.schema_version).toBe("1");
  });

  it("defaults schema_version to '1' when absent (backward compat for pre-versioning DB rows)", async () => {
    // Old workflow rows persisted before this field existed parse as
    // if they had `schema_version: "1"` — no migration required.
    const rawOldNode = {
      type: "tool",
      id: 0,
      description: "legacy",
      depends_on: [],      inputs: {
        name: "fetch_data_table",
        arguments: {},
      },
    };
    const parsed = CanonicalNodeSchema.parse(rawOldNode);
    expect(parsed.schema_version).toBe("1");
  });

  it("rejects an unknown schema_version (future v2 spec parsed by a v1 build)", async () => {
    const rawFutureNode = {
      type: "tool",
      schema_version: "2",
      id: 0,
      description: "future",
      depends_on: [],      inputs: {
        name: "fetch_data_table",
        arguments: {},
      },
    };
    expect(() => CanonicalNodeSchema.parse(rawFutureNode)).toThrow();
  });
});

// ─── Chart node canonicalization ──────────────────────────────────────

describe("canonicalize — chart node", () => {
  const STUB_DS_ID = "00000000-0000-4000-8000-000000000000";
  const noopDeps: CanonicalizeDeps = {
    getToolMetadata: async () => null,
    resolveAgentId: async () => null,
    resolveDataSourceId: async () => STUB_DS_ID,
  };

  function chartSpec(): LLMWorkflowSpec {
    return {
      name: "demo",
      nodes: [
        {
          id: 0,
          description: "extract",
          depends_on: [],
          type: "sql",
          inputs: {
            data_source_name: "src",
            sql_text: "SELECT month, sales FROM orders",
            dataset_name: "monthly_sales",
          },
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

  it("preserves inputs.{renderer,config,dataset} verbatim", async () => {
    const canonical = await canonicalize(chartSpec(), noopDeps);
    const node = canonical.nodes[1]!;
    if (node.type !== "chart") throw new Error("expected chart node");
    expect(node.inputs.renderer).toBe("echarts");
    expect(node.inputs.config).toMatchObject({
      xAxis: { type: "category" },
      series: [{ type: "bar", encode: { x: "month", y: "sales" } }],
    });
    expect(node.inputs.dataset).toBe("@nodes.0.rows");
  });

  it("does NOT consult getToolMetadata or resolveAgentId for chart nodes", async () => {
    const callLog: string[] = [];
    const deps: CanonicalizeDeps = {
      getToolMetadata: async (name) => {
        callLog.push(`tool:${name}`);
        return null;
      },
      resolveAgentId: async (display) => {
        callLog.push(`agent:${display}`);
        return null;
      },
      resolveDataSourceId: async () => null,
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
    await canonicalize(spec, deps);
    expect(callLog).toEqual([]);
  });

  it("supports multi-dataset (array of refs) — passes Zod min(2)", async () => {
    const spec = chartSpec();
    if (spec.nodes[1]!.type !== "chart") throw new Error();
    spec.nodes[1] = {
      ...spec.nodes[1]!,
      inputs: {
        ...spec.nodes[1]!.inputs,
        dataset: ["@nodes.0.rows", "@nodes.0.rows"],
      },
    };
    const canonical = await canonicalize(spec, noopDeps);
    const node = canonical.nodes[1]!;
    if (node.type !== "chart") throw new Error("expected chart node");
    expect(node.inputs.dataset).toEqual([
      "@nodes.0.rows",
      "@nodes.0.rows",
    ]);
  });

  it("stamps schema_version='1' on a chart node", async () => {
    const canonical = await canonicalize(chartSpec(), noopDeps);
    expect(canonical.nodes[1]!.schema_version).toBe("1");
  });

  it("canonical chart node round-trips through CanonicalWorkflowSpecSchema", async () => {
    const canonical = await canonicalize(chartSpec(), noopDeps);
    const parsed = CanonicalWorkflowSpecSchema.safeParse(canonical);
    expect(parsed.success).toBe(true);
  });
});
