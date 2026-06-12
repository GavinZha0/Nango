import { describe, expect, it } from "vitest";

import { WorkflowError, type WorkflowErrorCode } from "@/lib/workflows/error";
import { validate } from "@/lib/workflows/spec/validate";
import type {
  CanonicalNode,
  CanonicalWorkflowSpec,
} from "@/lib/workflows/spec/schema";

// ─── Fixtures ─────────────────────────────────────────────────────────

const AGENT_UUID = "11111111-1111-4111-8111-111111111111";

function toolNode(
  overrides: Partial<
    Omit<Extract<CanonicalNode, { type: "tool" }>, "type" | "inputs">
  > & {
    id: number;
    inputs?: Partial<Extract<CanonicalNode, { type: "tool" }>["inputs"]>;
  },
): CanonicalNode {
  const { inputs: inputsOverride, ...rest } = overrides;
  return {
    type: "tool",
    schema_version: "1",
    description: "n",
    depends_on: [],
    input_schema: {
      // Wrapper schema mirrors what canonicalize stamps in production.
      type: "object",
      properties: {
        name: { const: "fetch_data_table" },
        arguments: {
          type: "object",
          properties: {
            dataSourceId: { type: "string" },
            sql: { type: "string" },
          },
          required: ["dataSourceId", "sql"],
        },
      },
      required: ["name", "arguments"],
    },
    outputs: ["dataset", "rowCount"],
    output_schema: {
      type: "object",
      properties: { dataset: { type: "string" }, rowCount: { type: "number" } },
      required: ["dataset", "rowCount"],
    },
    ...rest,
    inputs: {
      name: inputsOverride?.name ?? "fetch_data_table",
      arguments: inputsOverride?.arguments ?? {
        dataSourceId: "x",
        sql: "select 1",
      },
    },
  };
}

function agentNode(
  overrides: Partial<
    Omit<Extract<CanonicalNode, { type: "agent" }>, "type" | "inputs">
  > & {
    id: number;
    inputs?: Partial<Extract<CanonicalNode, { type: "agent" }>["inputs"]>;
  },
): CanonicalNode {
  const { inputs: inputsOverride, ...rest } = overrides;
  return {
    type: "agent",
    schema_version: "1",
    description: "n",
    depends_on: [],
    ...rest,
    inputs: {
      name: inputsOverride?.name ?? "Builtin / DataAnalyst",
      agent_id: inputsOverride?.agent_id ?? AGENT_UUID,
      task: inputsOverride?.task ?? "summarise",
      ...(inputsOverride?.context !== undefined && {
        context: inputsOverride.context,
      }),
    },
  };
}

function spec(
  nodes: CanonicalNode[],
  outputs: Record<string, string> = { dataset: "@nodes.0.dataset" },
  extra?: Partial<CanonicalWorkflowSpec>,
): CanonicalWorkflowSpec {
  return {
    name: "demo",
    nodes,
    outputs,
    ...extra,
  };
}

function expectError(
  fn: () => void,
  code: WorkflowErrorCode,
  match?: RegExp,
): WorkflowError {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof WorkflowError)) throw e;
    expect(e.errorCode).toBe(code);
    if (match !== undefined) expect(e.message).toMatch(match);
    return e;
  }
  throw new Error(`Expected throw with code ${code}`);
}

// ─── Happy paths ──────────────────────────────────────────────────────

describe("validate — happy paths", () => {
  it("accepts a single-node workflow", () => {
    expect(() => validate(spec([toolNode({ id: 0 })]))).not.toThrow();
  });

  it("accepts a linear two-node DAG with ref + depends_on", () => {
    const s = spec([
      toolNode({ id: 0 }),
      toolNode({
        id: 1,
        depends_on: [0],
        input_schema: {
          type: "object",
          properties: { dataset: { type: "string" } },
          required: ["dataset"],
        },
        inputs: {
          name: "process_data",
          arguments: { dataset: "@nodes.0.dataset" },
        },
        outputs: ["result"],
        output_schema: {
          type: "object",
          properties: { result: { type: "string" } },
          required: ["result"],
        },
      }),
    ], { result: "@nodes.1.result" });
    expect(() => validate(s)).not.toThrow();
  });

  it("accepts diamond DAG with multiple paths to a leaf", () => {
    const s = spec([
      toolNode({ id: 0 }),
      toolNode({
        id: 1,
        depends_on: [0],        input_schema: undefined,
        inputs: {
          name: "minimal_tool",
          arguments: { x: "@nodes.0.dataset" },
        },
        outputs: ["a"],
      }),
      toolNode({
        id: 2,
        depends_on: [0],        input_schema: undefined,
        inputs: {
          name: "minimal_tool",
          arguments: { x: "@nodes.0.dataset" },
        },
        outputs: ["b"],
      }),
      toolNode({
        id: 3,
        depends_on: [1, 2],        input_schema: undefined,
        inputs: {
          name: "minimal_tool",
          arguments: { x: "@nodes.1.a", y: "@nodes.2.b" },
        },
        outputs: ["final"],
      }),
    ], { final: "@nodes.3.final" });
    expect(() => validate(s)).not.toThrow();
  });

  it("accepts embedded refs in SQL strings", () => {
    const s = spec([
      toolNode({
        id: 0,        inputs: {
          name: "fetch_data_table",
          arguments: {
          dataSourceId: "orders",
          sql: "SELECT * FROM o WHERE created >= @workflow.date_start",
        },
        },
      }),
    ], { dataset: "@nodes.0.dataset" }, {
      input_schema: {
        type: "object",
        properties: { date_start: { type: "string" } },
      },
    });
    expect(() => validate(s)).not.toThrow();
  });

  it("accepts @context.* refs without validation", () => {
    const s = spec([
      toolNode({
        id: 0,
        inputs: { arguments: { dataSourceId: "@context.tenant", sql: "select 1" } },      }),
    ]);
    expect(() => validate(s)).not.toThrow();
  });

  it("accepts agent nodes wired by ref", () => {
    const s = spec([
      toolNode({ id: 0 }),
      agentNode({
        id: 1,
        depends_on: [0],
        inputs: { task: "@nodes.0.dataset" },
      }),
    ], { result: "@nodes.1.result" });
    expect(() => validate(s)).not.toThrow();
  });

  it("skips field validation when target node has no declared outputs[]", () => {
    const s = spec([
      toolNode({ id: 0, outputs: undefined, output_schema: undefined }),
      toolNode({
        id: 1,
        depends_on: [0],        input_schema: undefined,
        inputs: {
          name: "minimal_tool",
          arguments: { anything: "@nodes.0.unknown_field" },
        },
        outputs: undefined,
      }),
    ], { x: "@nodes.0.also_unknown" });
    expect(() => validate(s)).not.toThrow();
  });

  it("skips @workflow.* key validation when input_schema is absent", () => {
    const s = spec([
      toolNode({
        id: 0,
        inputs: { arguments: { dataSourceId: "@workflow.anything", sql: "select 1" } },      }),
    ]);
    // No input_schema declared → @workflow.* refs are permissive.
    expect(() => validate(s)).not.toThrow();
  });
});

// ─── Empty / outputs ──────────────────────────────────────────────────

describe("validate — empty spec / outputs", () => {
  it("throws SPEC_SCHEMA_MISMATCH when nodes[] is empty", () => {
    expectError(
      () => validate(spec([])),
      "SPEC_SCHEMA_MISMATCH",
      /at least one node/i,
    );
  });

  it("throws SPEC_NO_OUTPUTS when spec.outputs is empty", () => {
    expectError(
      () => validate(spec([toolNode({ id: 0 })], {})),
      "SPEC_NO_OUTPUTS",
    );
  });
});

// ─── DAG / depends_on ─────────────────────────────────────────────────

describe("validate — DAG invariants", () => {
  it("throws SPEC_SCHEMA_MISMATCH on duplicate node ids", () => {
    const e = expectError(
      () => validate(spec([toolNode({ id: 0 }), toolNode({ id: 0 })])),
      "SPEC_SCHEMA_MISMATCH",
      /duplicate node id 0/i,
    );
    expect(e.nodeId).toBe(0);
  });

  it("throws SPEC_REF_UNKNOWN_NODE on depends_on referencing missing id", () => {
    const e = expectError(
      () =>
        validate(
          spec([toolNode({ id: 0, depends_on: [99] })]),
        ),
      "SPEC_REF_UNKNOWN_NODE",
      /depends_on references unknown node id 99/i,
    );
    expect(e.nodeId).toBe(0);
  });

  it("throws SPEC_DAG_CYCLE on self-dependency", () => {
    const e = expectError(
      () => validate(spec([toolNode({ id: 0, depends_on: [0] })])),
      "SPEC_DAG_CYCLE",
      /self-dependency/i,
    );
    expect(e.nodeId).toBe(0);
  });

  it("throws SPEC_DAG_CYCLE on 2-node cycle", () => {
    expectError(
      () =>
        validate(
          spec([
            toolNode({ id: 0, depends_on: [1] }),
            toolNode({ id: 1, depends_on: [0] }),
          ]),
        ),
      "SPEC_DAG_CYCLE",
    );
  });

  it("throws SPEC_DAG_CYCLE on 3-node cycle", () => {
    expectError(
      () =>
        validate(
          spec([
            toolNode({ id: 0, depends_on: [2] }),
            toolNode({ id: 1, depends_on: [0] }),
            toolNode({ id: 2, depends_on: [1] }),
          ]),
        ),
      "SPEC_DAG_CYCLE",
    );
  });
});

// ─── Node-input refs ──────────────────────────────────────────────────

describe("validate — node input refs", () => {
  it("throws SPEC_REF_UNKNOWN_NODE on @nodes.<unknown>.field", () => {
    const e = expectError(
      () =>
        validate(
          spec([
            toolNode({
              id: 0,              input_schema: undefined,
              inputs: {
                name: "minimal_tool",
                arguments: { x: "@nodes.99.field" },
              },
              outputs: ["a"],
            }),
          ], { a: "@nodes.0.a" }),
        ),
      "SPEC_REF_UNKNOWN_NODE",
      /@nodes\.99\.field/,
    );
    expect(e.nodeId).toBe(0);
  });

  it("throws SPEC_REF_UNREACHABLE when ref target isn't in depends_on closure", () => {
    // Node 1 references node 0, but doesn't list it in depends_on
    const e = expectError(
      () =>
        validate(
          spec([
            toolNode({ id: 0, outputs: ["dataset"] }),
            toolNode({
              id: 1,
              depends_on: [], // ← missing dep on 0              input_schema: undefined,
              inputs: {
                name: "minimal_tool",
                arguments: { x: "@nodes.0.dataset" },
              },
              outputs: ["a"],
            }),
          ], { a: "@nodes.1.a" }),
        ),
      "SPEC_REF_UNREACHABLE",
      /not in the transitive depends_on closure/i,
    );
    expect(e.nodeId).toBe(1);
  });

  it("accepts ref to grandparent (transitive closure)", () => {
    // 2 depends on 1 depends on 0; 2's input references node 0 — OK.
    const s = spec([
      toolNode({ id: 0 }),
      toolNode({
        id: 1,
        depends_on: [0],        input_schema: undefined,
        inputs: {
          name: "minimal_tool",
          arguments: { x: "@nodes.0.dataset" },
        },
        outputs: ["b"],
      }),
      toolNode({
        id: 2,
        depends_on: [1],        input_schema: undefined,
        inputs: {
          name: "minimal_tool",
          arguments: { y: "@nodes.0.dataset", z: "@nodes.1.b" },
        },
        outputs: ["c"],
      }),
    ], { c: "@nodes.2.c" });
    expect(() => validate(s)).not.toThrow();
  });

  it("throws SPEC_REF_UNKNOWN_FIELD when field isn't in target outputs[]", () => {
    const e = expectError(
      () =>
        validate(
          spec([
            toolNode({ id: 0, outputs: ["dataset"] }),
            toolNode({
              id: 1,
              depends_on: [0],              input_schema: undefined,
              inputs: {
                name: "minimal_tool",
                arguments: { x: "@nodes.0.no_such_field" },
              },
              outputs: ["a"],
            }),
          ], { a: "@nodes.1.a" }),
        ),
      "SPEC_REF_UNKNOWN_FIELD",
      /no_such_field/,
    );
    expect(e.nodeId).toBe(1);
  });

  it("detects embedded refs inside SQL strings", () => {
    const e = expectError(
      () =>
        validate(
          spec([
            toolNode({
              id: 0,              inputs: {
                name: "fetch_data_table",
                arguments: {
                dataSourceId: "orders",
                sql: "SELECT * FROM o WHERE x = @nodes.99.field",
              },
              },
            }),
          ]),
        ),
      "SPEC_REF_UNKNOWN_NODE",
    );
    expect(e.nodeId).toBe(0);
  });

  it("detects refs nested inside arrays/objects of node.inputs", () => {
    expectError(
      () =>
        validate(
          spec([
            toolNode({
              id: 0,              input_schema: undefined,
              inputs: {
                name: "minimal_tool",
                arguments: {
                deep: {
                  items: ["@nodes.99.bad"],
                },
              },
              },
              outputs: ["x"],
            }),
          ], { x: "@nodes.0.x" }),
        ),
      "SPEC_REF_UNKNOWN_NODE",
    );
  });
});

// ─── @workflow.* refs ──────────────────────────────────────────────────

describe("validate — workflow input refs", () => {
  it("throws SPEC_REF_UNKNOWN_FIELD when @workflow.key isn't in input_schema.properties", () => {
    const e = expectError(
      () =>
        validate(
          spec([
            toolNode({
              id: 0,              inputs: {
                name: "fetch_data_table",
                arguments: {
                dataSourceId: "@workflow.missing_key",
                sql: "select 1",
              },
              },
            }),
          ], { dataset: "@nodes.0.dataset" }, {
            input_schema: {
              type: "object",
              properties: { date_start: { type: "string" } },
            },
          }),
        ),
      "SPEC_REF_UNKNOWN_FIELD",
      /missing_key/,
    );
    expect(e.nodeId).toBe(0);
  });

  it("accepts @workflow.key when it's declared in input_schema.properties", () => {
    const s = spec([
      toolNode({
        id: 0,        inputs: {
          name: "fetch_data_table",
          arguments: {
          dataSourceId: "@workflow.tenant",
          sql: "select 1",
        },
        },
      }),
    ], { dataset: "@nodes.0.dataset" }, {
      input_schema: {
        type: "object",
        properties: { tenant: { type: "string" } },
      },
    });
    expect(() => validate(s)).not.toThrow();
  });
});

// ─── spec.outputs ──────────────────────────────────────────────────────

describe("validate — workflow-level outputs", () => {
  it("throws SPEC_SCHEMA_MISMATCH when an output value isn't a valid ref", () => {
    expectError(
      () =>
        validate(
          spec(
            [toolNode({ id: 0 })],
            { dataset: "not-a-ref-string" },
          ),
        ),
      "SPEC_SCHEMA_MISMATCH",
      /not a valid ref string/,
    );
  });

  it("throws SPEC_REF_UNKNOWN_NODE when an output points to a missing node", () => {
    expectError(
      () =>
        validate(
          spec(
            [toolNode({ id: 0 })],
            { dataset: "@nodes.99.dataset" },
          ),
        ),
      "SPEC_REF_UNKNOWN_NODE",
    );
  });

  it("throws SPEC_REF_UNKNOWN_FIELD when an output points to an undeclared field", () => {
    expectError(
      () =>
        validate(
          spec(
            [toolNode({ id: 0, outputs: ["dataset"] })],
            { dataset: "@nodes.0.bogus" },
          ),
        ),
      "SPEC_REF_UNKNOWN_FIELD",
    );
  });

  it("does NOT enforce reachability for workflow-level outputs", () => {
    // spec.outputs is workflow-scoped — no "editing node" so no
    // transitive closure check applies.
    const s = spec([
      toolNode({ id: 0 }),
      toolNode({
        id: 1,
        // independent path
        inputs: { name: "minimal_tool" },
        input_schema: undefined,
        outputs: ["x"],
      }),
    ], { dataset: "@nodes.0.dataset", x: "@nodes.1.x" });
    expect(() => validate(s)).not.toThrow();
  });
});

// ─── Tool input coverage ───────────────────────────────────────────────

describe("validate — tool input coverage (cheap key check)", () => {
  it("throws TOOL_INPUT_SCHEMA_MISMATCH when a required key is missing", () => {
    const e = expectError(
      () =>
        validate(
          spec([
            toolNode({
              id: 0,
              inputs: { arguments: { dataSourceId: "x" /* sql missing */ } },
            }),
          ]),
        ),
      "TOOL_INPUT_SCHEMA_MISMATCH",
      /requires argument 'sql'/,
    );
    expect(e.nodeId).toBe(0);
    expect(e.nodeName).toBe("fetch_data_table");
  });

  it("accepts when all required keys are provided (refs count as present)", () => {
    const s = spec([
      toolNode({
        id: 0,
        inputs: {
          arguments: {
            dataSourceId: "@workflow.tenant",
            sql: "@workflow.sql_template",
          },
        },
      }),
    ], { dataset: "@nodes.0.dataset" }, {
      input_schema: {
        type: "object",
        properties: {
          tenant: { type: "string" },
          sql_template: { type: "string" },
        },
      },
    });
    expect(() => validate(s)).not.toThrow();
  });

  it("skips coverage check when input_schema is absent", () => {
    const s = spec([
      toolNode({
        id: 0,        input_schema: undefined,
        inputs: {
          name: "minimal_tool",
          arguments: {},
        },
        outputs: ["x"],
      }),
    ], { x: "@nodes.0.x" });
    expect(() => validate(s)).not.toThrow();
  });

  it("does NOT enforce required-key check on agent nodes", () => {
    // Tool-coverage check applies to `type: "tool"` only. Agent
    // nodes carry their own structured inputs (`name`, `agent_id`,
    // `task`, optional `context`) which the Zod layer already
    // enforces — the validator simply doesn't second-guess them.
    const s = spec([
      agentNode({
        id: 0,
        inputs: { task: "Summarise" },
      }),
    ], { result: "@nodes.0.result" });
    expect(() => validate(s)).not.toThrow();
  });
});

// ─── D36: SQL node ref validation ─────────────────────────────────────

const SQL_STUB_DS_ID = "11111111-1111-4111-8111-111111111111";

function sqlNode(
  overrides: Partial<
    Omit<Extract<CanonicalNode, { type: "sql" }>, "type" | "inputs">
  > & {
    id: number;
    inputs?: Partial<Extract<CanonicalNode, { type: "sql" }>["inputs"]>;
  },
): CanonicalNode {
  const { inputs: inputsOverride, ...rest } = overrides;
  return {
    type: "sql",
    schema_version: "1",
    description: "extract",
    depends_on: [],
    ...rest,
    inputs: {
      data_source_name: inputsOverride?.data_source_name ?? "prod_pg",
      data_source_id: inputsOverride?.data_source_id ?? SQL_STUB_DS_ID,
      sql_text: inputsOverride?.sql_text ?? "SELECT 1",
      ...(inputsOverride?.dataset_name !== undefined && {
        dataset_name: inputsOverride.dataset_name,
      }),
    },
  };
}

describe("validate — SQL node ref carriers (D36)", () => {
  it("accepts a SQL node with no refs in its string fields", () => {
    expect(() =>
      validate(
        spec([sqlNode({ id: 0 })], { ds: "@nodes.0.dataset_name" }),
      ),
    ).not.toThrow();
  });

  it("walks sql_text for embedded @nodes refs and rejects unknown node id", () => {
    expectError(
      () =>
        validate(
          spec(
            [
              sqlNode({
                id: 0,
                inputs: { sql_text: "SELECT * FROM @nodes.99.dataset_name" },
              }),
            ],
            { ds: "@nodes.0.dataset_name" },
          ),
        ),
      "SPEC_REF_UNKNOWN_NODE",
    );
  });

  it("walks sql_text for embedded @nodes refs and rejects unreachable target", () => {
    // Two independent nodes; node 1's sql_text refers to node 0
    // but depends_on is empty → unreachable.
    expectError(
      () =>
        validate(
          spec(
            [
              sqlNode({
                id: 0,
                inputs: { dataset_name: "upstream" },
              }),
              sqlNode({
                id: 1,
                depends_on: [],
                inputs: {
                  data_source_name: "src",
                  sql_text: "SELECT * FROM @nodes.0.dataset_name",
                },
              }),
            ],
            { ds: "@nodes.1.dataset_name" },
          ),
        ),
      "SPEC_REF_UNREACHABLE",
    );
  });

  it("walks sql_text and rejects refs to fields not in target.outputs", () => {
    expectError(
      () =>
        validate(
          spec(
            [
              sqlNode({
                id: 0,
                inputs: { dataset_name: "upstream" },
              }),
              sqlNode({
                id: 1,
                depends_on: [0],
                inputs: {
                  data_source_name: "src",
                  sql_text: "SELECT * FROM @nodes.0.no_such_field",
                },
              }),
            ],
            { ds: "@nodes.1.dataset_name" },
          ),
        ),
      "SPEC_REF_UNKNOWN_FIELD",
    );
  });

  it("walks data_source_name for refs and rejects unknown workflow input key", () => {
    expectError(
      () =>
        validate(
          spec(
            [
              sqlNode({
                id: 0,
                inputs: { data_source_name: "@workflow.dsKey" },
              }),
            ],
            { ds: "@nodes.0.dataset_name" },
            {
              input_schema: {
                type: "object",
                properties: { otherKey: { type: "string" } },
              },
            },
          ),
        ),
      "SPEC_REF_UNKNOWN_FIELD",
    );
  });

  it("accepts a @workflow ref when key is declared in input_schema.properties", () => {
    expect(() =>
      validate(
        spec(
          [
            sqlNode({
              id: 0,
              inputs: { data_source_name: "@workflow.dsKey" },
            }),
          ],
          { ds: "@nodes.0.dataset_name" },
          {
            input_schema: {
              type: "object",
              properties: { dsKey: { type: "string" } },
            },
          },
        ),
      ),
    ).not.toThrow();
  });

  it("walks the optional dataset_name field for refs", () => {
    expectError(
      () =>
        validate(
          spec(
            [
              sqlNode({
                id: 0,
                inputs: { dataset_name: "@nodes.99.dataset_name" },
              }),
            ],
            { ds: "@nodes.0.dataset_name" },
          ),
        ),
      "SPEC_REF_UNKNOWN_NODE",
    );
  });

  it("allows downstream code node to ref the SQL node's dataset_name output", () => {
    // The canonical SQL node declares outputs ["dataset_name",
    // "total_rows", "returned_rows", "rows", "row_schema"]; a code
    // node downstream consuming @nodes.0.dataset_name should be
    // accepted.
    const sqlOut: CanonicalNode = sqlNode({
      id: 0,
      inputs: { dataset_name: "ds_orders" },
    });
    const codeNode: CanonicalNode = {
      type: "code",
      schema_version: "1",
      id: 1,
      description: "analyse",
      depends_on: [0],
      inputs: {
        language: "python",
        code_text: "import pandas",
        datasets: ["@nodes.0.dataset_name"],
      },
    };
    expect(() =>
      validate(spec([sqlOut, codeNode], { ds: "@nodes.1.ok" })),
    ).not.toThrow();
  });

  it("rejects downstream ref to a non-existent SQL output field", () => {
    const sqlOut: CanonicalNode = sqlNode({
      id: 0,
      inputs: { dataset_name: "ds_orders" },
    });
    const codeNode: CanonicalNode = {
      type: "code",
      schema_version: "1",
      id: 1,
      description: "analyse",
      depends_on: [0],
      inputs: {
        language: "python",
        code_text: "import pandas",
        // `schema` isn't a SQL-node output (replaced by row_schema).
        datasets: ["@nodes.0.schema"],
      },
    };
    expectError(
      () => validate(spec([sqlOut, codeNode], { ds: "@nodes.1.ok" })),
      "SPEC_REF_UNKNOWN_FIELD",
    );
  });
});

// ─── Chart node ref carriers ──────────────────────────────────────────

describe("validate — chart node ref carriers", () => {
  /** Helper: produce a SQL upstream + a chart node referencing it. */
  function chartTwoNodes(
    chartInputs: {
      renderer: "echarts";
      config: Record<string, unknown>;
      dataset: string | string[];
    },
  ): CanonicalNode[] {
    return [
      {
        type: "sql",
        schema_version: "1",
        id: 0,
        description: "upstream",
        depends_on: [],
        inputs: {
          data_source_name: "src",
          data_source_id: SQL_STUB_DS_ID,
          sql_text: "SELECT * FROM orders",
        },
      },
      {
        type: "chart",
        schema_version: "1",
        id: 1,
        description: "bar chart",
        depends_on: [0],
        inputs: chartInputs,
      },
    ];
  }

  it("accepts a single @path ref to an upstream output field", () => {
    const nodes = chartTwoNodes({
      renderer: "echarts",
      config: { series: [{ type: "bar" }] },
      dataset: "@nodes.0.rows",
    });
    expect(() =>
      validate(spec(nodes, { option: "@nodes.1.option" })),
    ).not.toThrow();
  });

  it("accepts an array of @path refs (multi-dataset)", () => {
    const nodes = chartTwoNodes({
      renderer: "echarts",
      config: { series: [{ type: "line" }] },
      dataset: ["@nodes.0.rows", "@nodes.0.rows"],
    });
    expect(() =>
      validate(spec(nodes, { option: "@nodes.1.option" })),
    ).not.toThrow();
  });

  it("rejects @path ref to a non-existent upstream node", () => {
    const nodes = chartTwoNodes({
      renderer: "echarts",
      config: { series: [{ type: "bar" }] },
      dataset: "@nodes.99.rows",
    });
    expectError(
      () => validate(spec(nodes, { option: "@nodes.1.option" })),
      "SPEC_REF_UNKNOWN_NODE",
    );
  });

  it("rejects @path ref to a field the upstream node does not produce", () => {
    const nodes = chartTwoNodes({
      renderer: "echarts",
      config: { series: [{ type: "bar" }] },
      dataset: "@nodes.0.does_not_exist",
    });
    expectError(
      () => validate(spec(nodes, { option: "@nodes.1.option" })),
      "SPEC_REF_UNKNOWN_FIELD",
    );
  });

  it("rejects @path ref to a node outside the closure (forward / sibling ref)", () => {
    const nodes: CanonicalNode[] = [
      {
        type: "chart",
        schema_version: "1",
        id: 0,
        description: "chart with bad forward ref",
        depends_on: [],
        inputs: {
          renderer: "echarts",
          config: { series: [{ type: "bar" }] },
          dataset: "@nodes.1.rows",
        },
      },
      {
        type: "sql",
        schema_version: "1",
        id: 1,
        description: "later sql",
        depends_on: [],
        inputs: {
          data_source_name: "src",
          data_source_id: SQL_STUB_DS_ID,
          sql_text: "SELECT * FROM orders",
        },
      },
    ];
    expectError(
      () => validate(spec(nodes, { option: "@nodes.0.option" })),
      "SPEC_REF_UNREACHABLE",
    );
  });

  it("rejects @path refs buried inside inputs.config → CHART_CONFIG_CONTAINS_REF", () => {
    // The chart engine treats config as an opaque option template and
    // never resolves refs inside it (D39.B). Embedding a ref in config
    // would be silently returned as a literal string to the browser.
    // validateChartConfigNoRefs catches this at save time.
    const nodes = chartTwoNodes({
      renderer: "echarts",
      config: {
        title: { text: "Sales report — last updated @nodes.0.category" },
        series: [{ type: "bar" }],
      },
      dataset: "@nodes.0.rows",
    });
    expectError(
      () => validate(spec(nodes, { option: "@nodes.1.option" })),
      "CHART_CONFIG_CONTAINS_REF",
    );
  });

  it("rejects embedded @inputs.* ref inside inputs.config", () => {
    const nodes = chartTwoNodes({
      renderer: "echarts",
      config: {
        title: { text: "Region: @inputs.region" },
        series: [{ type: "bar" }],
      },
      dataset: "@nodes.0.rows",
    });
    expectError(
      () =>
        validate(
          spec(nodes, { option: "@nodes.1.option" }, {
            input_schema: {
              type: "object",
              properties: { region: { type: "string" } },
            },
          }),
        ),
      "CHART_CONFIG_CONTAINS_REF",
    );
  });

  it("accepts config that contains '@' signs not matching ref grammar (e.g. email, ECharts @symbol)", () => {
    // '@' in non-ref contexts (email addresses, ECharts series symbol
    // names like '@circle') must NOT be rejected.
    const nodes = chartTwoNodes({
      renderer: "echarts",
      config: {
        title: { text: "Contact admin@example.com" },
        series: [{ type: "scatter", symbol: "@circle" }],
      },
      dataset: "@nodes.0.rows",
    });
    expect(() =>
      validate(spec(nodes, { option: "@nodes.1.option" })),
    ).not.toThrow();
  });

  it("rejects inputs.config exceeding 64 KB → CHART_CONFIG_TOO_LARGE", () => {
    // Simulates a not-refreshable chart (D39.C) where a large dataset
    // is baked directly into config.dataset.source.
    const nodes = chartTwoNodes({
      renderer: "echarts",
      config: {
        series: [{ type: "bar" }],
        // Pad past the 64 000-byte limit to trigger the guard.
        _pad: "x".repeat(65_000),
      },
      dataset: "@nodes.0.rows",
    });
    expectError(
      () => validate(spec(nodes, { option: "@nodes.1.option" })),
      "CHART_CONFIG_TOO_LARGE",
    );
  });

  it("accepts inputs.config that is exactly at the byte limit", () => {
    // Config at exactly 64 000 bytes should NOT be rejected.
    const nodes = chartTwoNodes({
      renderer: "echarts",
      config: {
        series: [{ type: "bar" }],
        // The JSON wrapper adds ~50 bytes; adjust pad to stay at limit.
        _pad: "x".repeat(63_940),
      },
      dataset: "@nodes.0.rows",
    });
    expect(() =>
      validate(spec(nodes, { option: "@nodes.1.option" })),
    ).not.toThrow();
  });
});

// ─── JavaScript constraints ────────────────────────────────────────────

describe("validate — JavaScript code node constraints", () => {
  function jsCodeNode(
    inputs: Partial<Extract<CanonicalNode, { type: "code" }>["inputs"]>,
  ): CanonicalNode {
    return {
      type: "code",
      schema_version: "1",
      id: 0,
      description: "js node",
      depends_on: [],
      inputs: {
        language: "javascript",
        code_text: "console.log('hi')",
        ...inputs,
      },
    };
  }

  it("accepts a valid JavaScript code_text node", () => {
    const node = jsCodeNode({});
    expect(() =>
      validate(spec([node], { result: "@nodes.0.ok" })),
    ).not.toThrow();
  });

  it("rejects JavaScript + non-empty datasets → JS_DATASETS_NOT_SUPPORTED", () => {
    const node = jsCodeNode({ datasets: ["orders_q4"] });
    expectError(
      () => validate(spec([node], { result: "@nodes.0.ok" })),
      "JS_DATASETS_NOT_SUPPORTED",
    );
  });

  it("accepts JavaScript with empty datasets array (treated as absent)", () => {
    // Empty array is allowed — the restriction is on non-empty arrays.
    const node = jsCodeNode({ datasets: [] });
    expect(() =>
      validate(spec([node], { result: "@nodes.0.ok" })),
    ).not.toThrow();
  });

  it("rejects JavaScript + code_file → SPEC_FEATURE_UNSUPPORTED", () => {
    const node: CanonicalNode = {
      type: "code",
      schema_version: "1",
      id: 0,
      description: "js file node",
      depends_on: [],
      inputs: {
        language: "javascript",
        code_file: "main.js",
      },
    };
    expectError(
      () => validate(spec([node], { result: "@nodes.0.ok" })),
      "SPEC_FEATURE_UNSUPPORTED",
    );
  });

  it("Python + datasets is still allowed (JS restriction does not affect Python)", () => {
    const node: CanonicalNode = {
      type: "code",
      schema_version: "1",
      id: 0,
      description: "python node",
      depends_on: [],
      inputs: {
        language: "python",
        code_text: "import pandas",
        datasets: ["orders_q4"],
      },
    };
    expect(() =>
      validate(spec([node], { result: "@nodes.0.ok" })),
    ).not.toThrow();
  });
});

// ─── Promoted-tool-as-node guard (C3) ─────────────────────────────────

describe("validate — PROMOTED_TOOL_AS_NODE guard", () => {
  /** Minimal tool node using a promoted tool name. */
  function promotedToolNode(toolName: string): CanonicalNode {
    return {
      type: "tool",
      schema_version: "1",
      id: 0,
      description: "should be rejected",
      depends_on: [],
      inputs: {
        name: toolName,
        arguments: {},
      },
    };
  }

  it("rejects run_code_in_sandbox as a tool node → PROMOTED_TOOL_AS_NODE", () => {
    expectError(
      () =>
        validate(
          spec([promotedToolNode("run_code_in_sandbox")], {
            result: "@nodes.0.stdout",
          }),
        ),
      "PROMOTED_TOOL_AS_NODE",
    );
  });

  it("rejects extract_dataset_by_sql as a tool node → PROMOTED_TOOL_AS_NODE", () => {
    expectError(
      () =>
        validate(
          spec([promotedToolNode("extract_dataset_by_sql")], {
            result: "@nodes.0.dataset_name",
          }),
        ),
      "PROMOTED_TOOL_AS_NODE",
    );
  });

  it("rejects generate_echarts_config as a tool node → PROMOTED_TOOL_AS_NODE", () => {
    expectError(
      () =>
        validate(
          spec([promotedToolNode("generate_echarts_config")], {
            result: "@nodes.0.option",
          }),
        ),
      "PROMOTED_TOOL_AS_NODE",
    );
  });

  it("rejects any generate_<lib>_config pattern → PROMOTED_TOOL_AS_NODE", () => {
    expectError(
      () =>
        validate(
          spec([promotedToolNode("generate_plotly_config")], {
            result: "@nodes.0.option",
          }),
        ),
      "PROMOTED_TOOL_AS_NODE",
    );
  });

  it("accepts a regular tool node that does not match any promoted name", () => {
    // Use a bare tool node without input_schema so validateToolInputCoverage
    // doesn't fire — this test is only checking the promoted-name guard.
    const regularTool: CanonicalNode = {
      type: "tool",
      schema_version: "1",
      id: 0,
      description: "plain search",
      depends_on: [],
      inputs: { name: "web_search", arguments: { query: "test" } },
      outputs: ["results"],
    };
    expect(() =>
      validate(spec([regularTool], { result: "@nodes.0.results" })),
    ).not.toThrow();
  });

  it("error message includes actionable hint pointing at the correct node type", () => {
    let caught: Error | undefined;
    try {
      validate(
        spec([promotedToolNode("run_code_in_sandbox")], {
          result: "@nodes.0.stdout",
        }),
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(WorkflowError);
    expect((caught as WorkflowError).message).toContain('type: "code"');
  });
});
